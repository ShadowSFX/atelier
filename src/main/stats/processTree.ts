import { readdirSync, readFileSync } from 'node:fs';
import type Koffi from 'koffi';
import { log } from '../log';

/** One process as sampled: CPU time is cumulative (ms) so the caller can compute a rate. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cpuMs: number;
  memory: number;
  /** Creation time (ms, platform clock): the newest descendant is the "foreground" one. */
  started: number;
}

/** Processes that are plumbing, never what the user runs. */
const PLUMBING = /^(conhost|openconsole|wslhost|wsl|wslrelay)(\.exe)?$/i;

export interface ProcessSampler {
  /** Every process (pid, parent, name); cheap. */
  list(): Map<number, { ppid: number; name: string }>;
  /** CPU/memory/start of specific pids. */
  details(pids: number[]): Map<number, ProcInfo>;
}

// ───────────── Windows (Toolhelp + process times through koffi; no native build needed) ─────────────

function windowsSampler(): ProcessSampler | null {
  try {
    // Loaded lazily: a missing native binary must only disable this feature.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const kernel32 = koffi.load('kernel32.dll');
    const psapi = koffi.load('psapi.dll');
    const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    const COUNTERS = koffi.struct('PROCESS_MEMORY_COUNTERS', {
      cb: 'uint32',
      PageFaultCount: 'uint32',
      PeakWorkingSetSize: 'size_t',
      WorkingSetSize: 'size_t',
      QuotaPeakPagedPoolUsage: 'size_t',
      QuotaPagedPoolUsage: 'size_t',
      QuotaPeakNonPagedPoolUsage: 'size_t',
      QuotaNonPagedPoolUsage: 'size_t',
      PagefileUsage: 'size_t',
      PeakPagefileUsage: 'size_t',
    });
    const CreateToolhelp32Snapshot = kernel32.func(
      'void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)',
    );
    const Process32FirstW = kernel32.func(
      'bool __stdcall Process32FirstW(void *h, _Inout_ PROCESSENTRY32W *e)',
    );
    const Process32NextW = kernel32.func(
      'bool __stdcall Process32NextW(void *h, _Inout_ PROCESSENTRY32W *e)',
    );
    const OpenProcess = kernel32.func(
      'void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)',
    );
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
    const GetProcessTimes = kernel32.func(
      'bool __stdcall GetProcessTimes(void *h, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)',
    );
    const GetProcessMemoryInfo = psapi.func(
      'bool __stdcall GetProcessMemoryInfo(void *h, _Inout_ PROCESS_MEMORY_COUNTERS *c, uint32 cb)',
    );
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const entrySize = koffi.sizeof(PROCESSENTRY32W);
    const countersSize = koffi.sizeof(COUNTERS);

    return {
      list() {
        const out = new Map<number, { ppid: number; name: string }>();
        const snap = CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
        if (!snap) return out;
        try {
          const e = { dwSize: entrySize } as Record<string, unknown>;
          if (Process32FirstW(snap, e)) {
            do {
              out.set(e.th32ProcessID as number, {
                ppid: e.th32ParentProcessID as number,
                name: e.szExeFile as string,
              });
            } while (Process32NextW(snap, e));
          }
        } finally {
          CloseHandle(snap);
        }
        return out;
      },
      details(pids) {
        const out = new Map<number, ProcInfo>();
        for (const pid of pids) {
          const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
          if (!h) continue;
          try {
            const creation = [0n],
              exit = [0n],
              kernel = [0n],
              user = [0n];
            const c = { cb: countersSize } as Record<string, unknown>;
            const times = GetProcessTimes(h, creation, exit, kernel, user);
            const mem = GetProcessMemoryInfo(h, c, countersSize);
            out.set(pid, {
              pid,
              ppid: 0,
              name: '',
              // FILETIME units are 100 ns.
              cpuMs: times ? Number(BigInt(kernel[0]!) + BigInt(user[0]!)) / 10_000 : 0,
              memory: mem ? Number(c.WorkingSetSize) : 0,
              started: times ? Number(BigInt(creation[0]!) / 10_000n) : 0,
            });
          } finally {
            CloseHandle(h);
          }
        }
        return out;
      },
    };
  } catch (err) {
    log.warn('process sampler unavailable', err);
    return null;
  }
}

// ───────────── Linux (/proc) ─────────────

function linuxSampler(): ProcessSampler {
  const tick = 1000 / 100; // USER_HZ is 100 on every mainstream kernel
  const page = 4096;
  const stat = (pid: number) => {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parentheses: it ends at the last ')'.
    const close = raw.lastIndexOf(')');
    const name = raw.slice(raw.indexOf('(') + 1, close);
    const f = raw.slice(close + 2).split(' ');
    return { name, ppid: Number(f[1]), utime: Number(f[11]), stime: Number(f[12]), start: Number(f[19]) };
  };
  return {
    list() {
      const out = new Map<number, { ppid: number; name: string }>();
      for (const d of readdirSync('/proc')) {
        const pid = Number(d);
        if (!Number.isInteger(pid)) continue;
        try {
          const s = stat(pid);
          out.set(pid, { ppid: s.ppid, name: s.name });
        } catch {
          /* exited meanwhile */
        }
      }
      return out;
    },
    details(pids) {
      const out = new Map<number, ProcInfo>();
      for (const pid of pids) {
        try {
          const s = stat(pid);
          const rss = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * page;
          out.set(pid, {
            pid,
            ppid: s.ppid,
            name: s.name,
            cpuMs: (s.utime + s.stime) * tick,
            memory: rss,
            started: s.start * tick,
          });
        } catch {
          /* exited */
        }
      }
      return out;
    },
  };
}

export function createSampler(): ProcessSampler | null {
  if (process.platform === 'win32') return windowsSampler();
  if (process.platform === 'linux') return linuxSampler();
  return null;
}

/** The shell's descendants (shell included), skipping console plumbing. */
export function descendants(list: Map<number, { ppid: number; name: string }>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, p] of list) {
    if (pid === p.ppid) continue;
    let arr = children.get(p.ppid);
    if (!arr) children.set(p.ppid, (arr = []));
    arr.push(pid);
  }
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || !list.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

export function isPlumbing(name: string): boolean {
  return PLUMBING.test(name);
}
