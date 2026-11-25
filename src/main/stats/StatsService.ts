import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { app } from 'electron';
import { STATS_INTERVAL_MS } from '@shared/constants';
import type { StatsSnapshot, TerminalStats } from '@shared/ipc';
import { log } from '../log';
import { createSampler, descendants, isPlumbing, type ProcessSampler } from './processTree';

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Samples system and per-terminal resource use every STATS_INTERVAL_MS while the window is visible.
 * Per-terminal numbers cover the shell's whole process tree; the "foreground" process is its newest descendant.
 */
export class StatsService {
  private timer: NodeJS.Timeout | null = null;
  private lastCpu = cpuTotals();
  private lastAt = Date.now();
  private readonly lastProcCpu = new Map<number, number>();
  private readonly sampler: ProcessSampler | null = createSampler();
  private projectPath: string | null = null;
  private terminalIds: string[] = [];

  constructor(
    private readonly shellPids: () => Map<string, number>,
    private readonly emit: (s: StatsSnapshot) => void,
  ) {}

  /** What the window shows: the active project's directory (disk) and its terminals. */
  watch(projectPath: string | null, terminalIds: string[]): void {
    this.projectPath = projectPath;
    this.terminalIds = terminalIds;
  }

  setActive(active: boolean): void {
    if (active && !this.timer) {
      this.lastCpu = cpuTotals();
      this.lastAt = Date.now();
      this.timer = setInterval(() => this.tick(), STATS_INTERVAL_MS);
      setTimeout(() => this.tick(), 300);
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    try {
      this.emit(this.sample());
    } catch (err) {
      log.warn('stats sample failed', err);
    }
  }

  private sample(): StatsSnapshot {
    const now = Date.now();
    const elapsed = Math.max(1, now - this.lastAt);
    this.lastAt = now;

    const cur = cpuTotals();
    const dTotal = cur.total - this.lastCpu.total;
    const cpu = dTotal > 0 ? 1 - (cur.idle - this.lastCpu.idle) / dTotal : 0;
    this.lastCpu = cur;

    let disk: StatsSnapshot['disk'] = null;
    if (this.projectPath) {
      try {
        const s = statfsSync(this.projectPath);
        disk = { path: this.projectPath, total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
      } catch {
        /* unreachable drive: no disk figure */
      }
    }

    const appMemory = app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0);
    return {
      cpu: Math.min(1, Math.max(0, cpu)),
      memTotal: totalmem(),
      memUsed: totalmem() - freemem(),
      disk,
      appMemory,
      terminals: this.terminalStats(elapsed),
    };
  }

  private terminalStats(elapsedMs: number): TerminalStats[] {
    if (!this.sampler || this.terminalIds.length === 0) return [];
    const shells = this.shellPids();
    const list = this.sampler.list();
    const wanted = new Map<string, number[]>();
    const all: number[] = [];
    for (const id of this.terminalIds) {
      const pid = shells.get(id);
      if (!pid) continue;
      const tree = descendants(list, pid).filter((p) => !isPlumbing(list.get(p)?.name ?? ''));
      wanted.set(id, tree);
      all.push(...tree);
    }
    const details = this.sampler.details(all);
    const cores = Math.max(1, cpus().length);
    const seen = new Set<number>();
    const out: TerminalStats[] = [];

    for (const [id, tree] of wanted) {
      const shell = details.get(tree[0]!);
      const shellName = (list.get(tree[0]!)?.name ?? '').toLowerCase();
      let cpu = 0;
      let memory = 0;
      let fg: { name: string; started: number } | null = null;
      for (const pid of tree) {
        const d = details.get(pid);
        // A recorded parent pid can belong to a process that died and whose pid was reused by our shell.
        if (!d || (shell && pid !== shell.pid && d.started < shell.started)) continue;
        seen.add(pid);
        const prev = this.lastProcCpu.get(pid);
        this.lastProcCpu.set(pid, d.cpuMs);
        if (prev !== undefined) cpu += Math.max(0, d.cpuMs - prev) / elapsedMs / cores;
        memory += d.memory;
        const name = list.get(pid)?.name ?? '';
        // Git Bash's bin\bash.exe re-runs usr\bin\bash.exe: the shell itself is not "what runs".
        const isShell = name.toLowerCase() === shellName;
        if (pid !== tree[0] && !isShell && (!fg || d.started >= fg.started))
          fg = { name, started: d.started };
      }
      out.push({
        terminalId: id,
        cpu: Math.min(1, cpu),
        memory,
        foreground: fg ? fg.name.replace(/\.exe$/i, '') : null,
      });
    }
    for (const pid of this.lastProcCpu.keys()) if (!seen.has(pid)) this.lastProcCpu.delete(pid);
    return out;
  }

  /** Pids of what runs inside each terminal besides the shell (for "close anyway?" confirmations). */
  busy(terminalIds: string[]): string[] {
    if (!this.sampler) return [];
    const shells = this.shellPids();
    const list = this.sampler.list();
    return terminalIds.filter((id) => {
      const pid = shells.get(id);
      if (!pid) return false;
      const shellName = (list.get(pid)?.name ?? '').toLowerCase();
      return descendants(list, pid).some((p) => {
        const name = list.get(p)?.name ?? '';
        return p !== pid && !isPlumbing(name) && name.toLowerCase() !== shellName;
      });
    });
  }
}
