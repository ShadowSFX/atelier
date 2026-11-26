import { randomUUID } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ClaudeState } from '@shared/ipc';
import { isInsidePath } from '@shared/launchers';
import { rebaseLibrary, rebasePath, rebaseWorkspace } from '@shared/library';
import {
  parentOf,
  pathBlockers,
  sameVolume,
  type MoveBlocker,
  type MovePhase,
  type MovePlan,
  type MoveProgress,
  type MoveTerminal,
  type MoveWarning,
} from '@shared/move';
import { pathIdentity, type Workspace } from '@shared/workspace';
import { log } from '../log';
import { readJson, writeFileAtomic } from '../store/JsonStore';
import { claudeDirsFor, migrateClaudeDirs, migrateClaudeJson } from './claudeData';
import { copyTree, treeSize } from './copyTree';
import { isWorktree, linkedWorktrees, repairWorktrees } from './git';
import type { LibraryService } from './LibraryService';

/** Retries of a rename while something still holds the folder (a shell exiting, the indexer, an antivirus). */
const RENAME_DELAYS_MS = [200, 500, 1000, 2000, 4000];
const ACK_TIMEOUT_MS = 8_000;
const PLAN_TTL_MS = 10 * 60_000;
const SIZE_BUDGET_MS = 8_000;

export interface MoverDeps {
  library: LibraryService;
  workspace: { get(): Workspace; set(ws: Workspace): void };
  journalFile: string;
  claudeConfigDir: string;
  claudeJson: string;
  /** Folders that must never move (home, the exe's, Atelier's data, Claude's config). */
  protectedPaths: () => string[];
  running: (terminalId: string) => boolean;
  busy: (terminalIds: string[]) => string[];
  foreground: (terminalIds: string[]) => Map<string, string | null>;
  claudeState: (terminalId: string) => ClaudeState | null;
  kill: (terminalId: string) => void;
  settled: () => Promise<void>;
  /** Stops Claude Code background sessions (they outlive their terminal and keep the folder open). */
  stopBackground: (sessionIds: string[]) => Promise<void>;
  git: () => string | null;
  progress: (p: MoveProgress) => void;
  suspend: (moveId: string, terminalIds: string[]) => void;
  committed: (moveId: string, oldPath: string, newPath: string, terminalIds: string[]) => void;
  aborted: (moveId: string, terminalIds: string[]) => void;
  now?: () => number;
}

/** Written at each step: a move interrupted by a crash or power cut is finished or undone on the next start. */
interface Journal {
  id: string;
  entryId: string;
  source: string;
  destination: string;
  mode: 'rename' | 'copy';
  phase: 'moving' | 'committed';
  /** copy: this move created the destination (only then may a rollback delete it). */
  createdDestination: boolean;
  /** copy: where the source was put aside once the copy was verified. */
  trash: string | null;
}

class MoveError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function errCode(err: unknown): string {
  return (err as { code?: string }).code ?? '';
}

/** The nearest folder of `path` that exists (its drive tells the volume). */
function existingAncestor(path: string): string | null {
  let p = path;
  for (let i = 0; i < 64; i++) {
    if (exists(p)) return p;
    const up = parentOf(p);
    if (up === p) return null;
    p = up;
  }
  return null;
}

/**
 * Moves project folders. Main drives every step (it owns the shells, the library and its copy of the workspace);
 * the renderer only saves its terminals' screens before ('move:suspend') and rebases its workspace and starts them
 * again after ('move:committed'). Windows can't rename a folder a process works in, so the terminals inside it
 * stop first. Nothing is undone after the folder has moved: the rest (Claude data, git links) is best effort and
 * reported.
 */
export class Mover {
  private readonly plans = new Map<
    string,
    { plan: MovePlan; at: number; worktrees: string[]; worktree: boolean }
  >();
  private current: { id: string; abort: AbortController; phase: MovePhase; committed: boolean } | null = null;
  private readonly acks = new Map<string, () => void>();
  /** Rebases not yet applied by the renderer: its workspace saves are rebased until it acks. */
  private readonly pending: { id: string; from: string; to: string }[] = [];
  private readonly now: () => number;

  constructor(private readonly d: MoverDeps) {
    this.now = d.now ?? Date.now;
  }

  busy(): boolean {
    return this.current !== null;
  }

  /** A workspace the renderer saved before it applied a move: rebased so main's copy never goes back. */
  rebaseIncoming(ws: Workspace): Workspace {
    return this.pending.reduce((w, p) => rebaseWorkspace(w, p.from, p.to), ws);
  }

  ack(moveId: string, kind: 'suspended' | 'applied'): void {
    this.acks.get(moveId + ':' + kind)?.();
  }

  private waitAck(moveId: string, kind: 'suspended' | 'applied'): Promise<void> {
    return new Promise<void>((resolve) => {
      const key = moveId + ':' + kind;
      const timer = setTimeout(done, ACK_TIMEOUT_MS);
      this.acks.set(key, done);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    }).finally(() => this.acks.delete(moveId + ':' + kind));
  }

  /** Terminals of every open project whose folder is inside `root` (where they would start, or work now). */
  private terminalsInside(
    root: string,
  ): { id: string; name: string; projectId: string; projectName: string; sessionId: string | null }[] {
    const out = [];
    for (const p of this.d.workspace.get().projects)
      for (const t of p.terminals)
        if (isInsidePath(t.lastCwd ?? p.path, root))
          out.push({
            id: t.id,
            name: t.name,
            projectId: p.id,
            projectName: p.name,
            sessionId: t.claude?.active ? t.claude.sessionId : null,
          });
    return out;
  }

  async plan(entryId: string, destination: string): Promise<MovePlan> {
    const entry = this.d.library.entry(entryId);
    const source = entry?.path ?? '';
    const blockers: MoveBlocker[] = [];
    const warnings: MoveWarning[] = [];
    if (!entry) blockers.push('source-missing');
    blockers.push(
      ...pathBlockers({
        source,
        destination,
        sourceExists: !!entry && exists(source),
        destinationExists: exists(destination),
        protectedPaths: this.d.protectedPaths(),
      }),
    );
    if (this.current) blockers.push('busy');
    const anchor = existingAncestor(parentOf(destination));
    if (!anchor) blockers.push('dest-unreachable');

    let crossVolume = !sameVolume(source, destination);
    try {
      if (anchor && exists(source)) crossVolume = statSync(source).dev !== statSync(anchor).dev;
    } catch {
      /* keep the guess */
    }
    let bytes: number | null = null;
    if (crossVolume && blockers.length === 0) {
      warnings.push('cross-volume');
      const size = await treeSize(source, SIZE_BUDGET_MS, this.now);
      bytes = size.partial ? null : size.bytes;
      try {
        const fs = await statfs(anchor!);
        if (size.bytes > fs.bavail * fs.bsize) blockers.push('no-space');
      } catch {
        /* unknown free space: the copy reports ENOSPC if it comes to that */
      }
    }
    const worktree = entry ? await isWorktree(source) : false;
    const worktrees = entry ? await linkedWorktrees(source) : [];
    if (worktree) warnings.push('is-worktree');
    if (worktrees.length > 0) warnings.push('worktrees');
    if (['.venv', 'venv', 'env'].some((v) => exists(join(source, v, 'pyvenv.cfg')))) warnings.push('venv');
    if (['CMakeCache.txt', join('build', 'CMakeCache.txt')].some((f) => exists(join(source, f))))
      warnings.push('cmake');

    const inside = entry ? this.terminalsInside(source).filter((t) => this.d.running(t.id)) : [];
    const busy = new Set(this.d.busy(inside.map((t) => t.id)));
    const fg = this.d.foreground(inside.map((t) => t.id));
    const terminals: MoveTerminal[] = inside.map((t) => ({
      id: t.id,
      name: t.name,
      projectId: t.projectId,
      projectName: t.projectName,
      busy: busy.has(t.id),
      foreground: fg.get(t.id) ?? null,
      claude: this.d.claudeState(t.id),
    }));
    const nested = entry
      ? this.d.library
          .get()
          .entries.filter((e) => e.id !== entry.id && isInsidePath(e.path, source))
          .map((e) => ({ id: e.id, name: e.name }))
      : [];
    const claudeDirs = entry ? (await claudeDirsFor(this.d.claudeConfigDir, source, destination)).length : 0;

    const plan: MovePlan = {
      id: 'm' + randomUUID().replace(/-/g, '').slice(0, 12),
      entryId,
      source,
      destination,
      crossVolume,
      bytes,
      blockers: [...new Set(blockers)],
      warnings,
      terminals,
      nested,
      claudeDirs,
      worktrees,
    };
    for (const [id, p] of this.plans) if (this.now() - p.at > PLAN_TTL_MS) this.plans.delete(id);
    this.plans.set(plan.id, { plan, at: this.now(), worktrees, worktree });
    return plan;
  }

  start(planId: string, wait: boolean): boolean {
    const stored = this.plans.get(planId);
    if (!stored || this.current || stored.plan.blockers.length > 0) return false;
    const { plan } = stored;
    // Things may have changed since the plan was shown.
    if (exists(plan.destination) && pathIdentity(plan.destination) !== pathIdentity(plan.source))
      return false;
    if (!exists(plan.source)) return false;
    this.plans.delete(planId);
    const abort = new AbortController();
    this.current = { id: plan.id, abort, phase: 'waiting', committed: false };
    void this.run(plan, stored.worktrees, stored.worktree, wait, abort.signal).finally(() => {
      this.current = null;
    });
    return true;
  }

  cancel(moveId: string): void {
    if (this.current?.id === moveId && !this.current.committed) this.current.abort.abort();
  }

  private report(plan: MovePlan, phase: MovePhase, extra: Partial<MoveProgress> = {}): void {
    if (this.current?.id === plan.id) this.current.phase = phase;
    this.d.progress({
      id: plan.id,
      entryId: plan.entryId,
      phase,
      source: plan.source,
      destination: plan.destination,
      ...extra,
    });
  }

  private journal(j: Journal | null): void {
    try {
      if (j) writeFileAtomic(this.d.journalFile, JSON.stringify(j, null, 2));
      else {
        // Synchronous: the next start must never see a journal of a move that is over.
        rmSync(this.d.journalFile, { force: true });
        rmSync(this.d.journalFile + '.bak', { force: true });
      }
    } catch (err) {
      log.warn('move journal', err);
    }
  }

  private async run(
    plan: MovePlan,
    worktrees: string[],
    worktree: boolean,
    wait: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { source, destination } = plan;
    const lockIds = [plan.entryId, ...plan.nested.map((n) => n.id)];
    // Terminals inside right now (one may have cd'ed in since the plan).
    const inside = this.terminalsInside(source);
    const live = inside.filter((t) => this.d.running(t.id)).map((t) => t.id);
    this.d.library.lock(lockIds);
    let mode: 'rename' | 'copy' = plan.crossVolume ? 'copy' : 'rename';
    let createdDestination = false;
    let trash: string | null = null;
    let suspended = false;
    try {
      // 1. Claude sessions finish their turn first (when the user chose to wait).
      if (wait) {
        this.report(plan, 'waiting');
        while (live.some((id) => ['busy', 'waiting'].includes(this.d.claudeState(id) ?? ''))) {
          if (signal.aborted) throw new MoveError('cancelled');
          await sleep(1000);
        }
      }
      if (signal.aborted) throw new MoveError('cancelled');

      // 2. Stop what runs inside: the terminals (their screens saved) and Claude's background sessions.
      this.report(plan, 'stopping');
      if (live.length > 0) {
        const acked = this.waitAck(plan.id, 'suspended');
        this.d.suspend(plan.id, live);
        await acked;
      }
      suspended = true;
      for (const id of live) this.d.kill(id);
      await this.d.settled();
      const sessions = inside.map((t) => t.sessionId).filter((s): s is string => !!s);
      if (sessions.length > 0)
        await this.d.stopBackground(sessions).catch((err: unknown) => log.warn('stop background', err));
      await sleep(500);
      if (signal.aborted) throw new MoveError('cancelled');

      // 3. Move: a rename on the same drive, else copy + verify + put the source aside.
      await mkdir(parentOf(destination), { recursive: true });
      const j: Journal = {
        id: plan.id,
        entryId: plan.entryId,
        source,
        destination,
        mode,
        phase: 'moving',
        createdDestination: false,
        trash: null,
      };
      if (mode === 'rename') {
        this.journal(j);
        this.report(plan, 'moving');
        try {
          await this.renameRetrying(source, destination, signal);
        } catch (err) {
          if (errCode(err) !== 'EXDEV') throw err;
          mode = 'copy';
        }
      }
      if (mode === 'copy') {
        const size = await treeSize(source, 60_000, this.now);
        createdDestination = true;
        this.journal({ ...j, mode, createdDestination });
        this.report(plan, 'copying', { bytes: 0, totalBytes: size.bytes });
        let lastReport = 0;
        const copied = await copyTree(source, destination, {
          signal,
          onProgress: (bytes) => {
            if (this.now() - lastReport < 250) return;
            lastReport = this.now();
            this.report(plan, 'copying', { bytes, totalBytes: size.bytes });
          },
        });
        this.report(plan, 'verifying');
        const check = await treeSize(destination, 120_000, this.now);
        if (
          !size.partial &&
          (check.files !== size.files || check.bytes !== size.bytes || copied.files !== size.files)
        )
          throw new MoveError('verify');
        trash = join(dirname(source), '.atelier-trash-' + plan.id + '-' + basename(source));
        this.journal({ ...j, mode, createdDestination, trash });
        await this.renameRetrying(source, trash, signal);
      }
    } catch (err) {
      // Nothing moved: undo what this move did and start the terminals again where they were.
      const code = err instanceof MoveError ? err.code : errCode(err);
      log.warn('move failed', source, destination, err);
      if (createdDestination)
        await rm(destination, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      this.journal(null);
      this.d.library.unlock(lockIds);
      if (suspended || live.length > 0) this.d.aborted(plan.id, live);
      this.report(plan, code === 'cancelled' ? 'cancelled' : 'failed', { error: friendlyCode(code, err) });
      return;
    }

    // ── The folder has moved: from here on nothing is undone. ──
    if (this.current) this.current.committed = true;
    this.journal({
      id: plan.id,
      entryId: plan.entryId,
      source,
      destination,
      mode,
      phase: 'committed',
      createdDestination,
      trash,
    });
    const notes = await this.finish(plan.id, source, destination, worktrees, worktree, (phase) =>
      this.report(plan, phase),
    );
    const acked = this.waitAck(plan.id, 'applied');
    this.d.committed(plan.id, source, destination, live);
    this.report(plan, 'restarting');
    await acked;
    const at = this.pending.findIndex((p) => p.id === plan.id);
    if (at >= 0) this.pending.splice(at, 1);
    this.d.library.unlock(lockIds);
    this.journal(null);
    if (trash)
      void rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((err: unknown) =>
        log.warn('move: trash not deleted', trash, err),
      );
    this.report(plan, 'done', notes.length ? { notes } : {});
  }

  /** Library, workspace, Claude data and git links follow the folder. Returns what couldn't be done. */
  private async finish(
    id: string,
    source: string,
    destination: string,
    worktrees: string[],
    worktree: boolean,
    report: (phase: MovePhase) => void,
  ): Promise<string[]> {
    const notes: string[] = [];
    this.pending.push({ id, from: source, to: destination });
    this.d.library.replace(rebaseLibrary(this.d.library.get(), source, destination));
    this.d.workspace.set(rebaseWorkspace(this.d.workspace.get(), source, destination));

    report('claude');
    try {
      const dirs = await claudeDirsFor(this.d.claudeConfigDir, source, destination);
      const backup = join(this.d.claudeConfigDir, 'projects', '.atelier-backup', id);
      const r = await migrateClaudeDirs(this.d.claudeConfigDir, dirs, source, destination, backup);
      if (r.notes.length) notes.push('claude-partial');
      if (r.backup) void rm(r.backup, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (dirs.length > 0) await migrateClaudeJson(this.d.claudeJson, source, destination);
    } catch (err) {
      log.warn('move: claude data', err);
      notes.push('claude-partial');
    }

    if (worktree || worktrees.length > 0) {
      report('git');
      const git = this.d.git();
      const ok = await repairWorktrees(
        git,
        destination,
        worktrees.map((w) => rebasePath(w, source, destination)),
      );
      if (!ok) notes.push(git ? 'git-failed' : 'git-missing');
    }
    return notes;
  }

  private async renameRetrying(from: string, to: string, signal: AbortSignal): Promise<void> {
    // Only the letter case changes: through a temporary name (a case-insensitive file system sees one folder).
    if (pathIdentity(from) === pathIdentity(to) && from !== to) {
      const tmp = from + '.atelier-' + randomUUID().slice(0, 8);
      await this.renameRetrying(from, tmp, signal);
      await rename(tmp, to);
      return;
    }
    for (let i = 0; ; i++) {
      try {
        await rename(from, to);
        return;
      } catch (err) {
        const code = errCode(err);
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= RENAME_DELAYS_MS.length || signal.aborted) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw new MoveError('in-use');
          throw err;
        }
        await sleep(RENAME_DELAYS_MS[i]!);
      }
    }
  }

  /**
   * Startup: a move the journal says was interrupted. The folder moved (rename done, or the copy's source put aside):
   * finish it. It didn't: undo the partial copy. Runs before the window loads, so the renderer reads rebased stores.
   */
  async recover(): Promise<void> {
    const raw = readJson(this.d.journalFile) as Partial<Journal> | undefined;
    if (
      !raw ||
      typeof raw.source !== 'string' ||
      typeof raw.destination !== 'string' ||
      typeof raw.id !== 'string'
    )
      return;
    const j = raw as Journal;
    const sourceThere = exists(j.source);
    const destThere = exists(j.destination);
    let committed = j.phase === 'committed';
    if (!committed && j.mode === 'rename') committed = destThere && !sourceThere;
    if (!committed && j.mode === 'copy')
      committed = !!j.trash && exists(j.trash) && !sourceThere && destThere;
    if (committed) {
      log.info('move: finishing an interrupted move', j.source, '→', j.destination);
      const notes = await this.finish(j.id, j.source, j.destination, [], false, () => undefined);
      this.pending.splice(0);
      if (notes.length) log.warn('move: finished with notes', notes);
      if (j.trash) void rm(j.trash, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    } else if (j.mode === 'copy' && j.createdDestination && sourceThere && destThere) {
      log.info('move: removing the partial copy of an interrupted move', j.destination);
      await rm(j.destination, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) =>
        log.warn('move: partial copy', err),
      );
    }
    this.journal(null);
  }
}

function friendlyCode(code: string, err: unknown): string {
  if (['in-use', 'cancelled', 'verify'].includes(code)) return code;
  if (code === 'ENOSPC') return 'no-space';
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'dest-exists';
  if (code === 'ENOENT') return 'source-missing';
  return 'error:' + (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
