import type Koffi from 'koffi';
import { windowsCommandLine } from '@shared/shell';
import { log } from './log';

const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const CREATE_NO_WINDOW = 0x08000000;

type CreateProcess = (
  app: string,
  cmd: string,
  pa: null,
  ta: null,
  inherit: boolean,
  flags: number,
  env: null,
  cwd: string,
  si: Record<string, unknown>,
  pi: Record<string, unknown>,
) => boolean;

let api: { create: CreateProcess; close: (h: unknown) => boolean; siSize: number } | null | undefined;

function load(): typeof api {
  if (api !== undefined) return api;
  try {
    // Loaded lazily: a missing native binary must only disable this feature.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const kernel32 = koffi.load('kernel32.dll');
    const STARTUPINFOW = koffi.struct('ATELIER_STARTUPINFOW', {
      cb: 'uint32',
      lpReserved: 'void *',
      lpDesktop: 'void *',
      lpTitle: 'void *',
      dwX: 'uint32',
      dwY: 'uint32',
      dwXSize: 'uint32',
      dwYSize: 'uint32',
      dwXCountChars: 'uint32',
      dwYCountChars: 'uint32',
      dwFillAttribute: 'uint32',
      dwFlags: 'uint32',
      wShowWindow: 'uint16',
      cbReserved2: 'uint16',
      lpReserved2: 'void *',
      hStdInput: 'void *',
      hStdOutput: 'void *',
      hStdError: 'void *',
    });
    koffi.struct('ATELIER_PROCESS_INFORMATION', {
      hProcess: 'void *',
      hThread: 'void *',
      dwProcessId: 'uint32',
      dwThreadId: 'uint32',
    });
    api = {
      create: kernel32.func(
        'bool __stdcall CreateProcessW(str16 app, str16 cmd, void *pa, void *ta, bool inherit, uint32 flags, void *env, str16 cwd, ATELIER_STARTUPINFOW *si, _Out_ ATELIER_PROCESS_INFORMATION *pi)',
      ) as CreateProcess,
      close: kernel32.func('bool __stdcall CloseHandle(void *h)') as (h: unknown) => boolean,
      siSize: koffi.sizeof(STARTUPINFOW),
    };
  } catch (err) {
    log.warn('CreateProcess unavailable', err);
    api = null;
  }
  return api;
}

/**
 * Windows: starts a console program with a hidden console that outlives Atelier. Node can't: `detached` starts it
 * with no console at all (DETACHED_PROCESS: powershell.exe exits at once without running anything), and a
 * non-detached child is put in libuv's kill-on-close job, so it dies with Atelier. Breaks away from Atelier's own job
 * when that job allows it. Returns the pid, or null when it didn't start.
 */
export function startHidden(exe: string, args: string[], cwd: string): number | null {
  const k = load();
  if (!k) return null;
  const cmd = windowsCommandLine([exe, ...args]);
  for (const extra of [CREATE_BREAKAWAY_FROM_JOB, 0]) {
    const pi: Record<string, unknown> = {};
    const ok = k.create(
      exe,
      cmd,
      null,
      null,
      false,
      CREATE_NO_WINDOW | extra,
      null,
      cwd,
      { cb: k.siSize },
      pi,
    );
    if (ok) {
      k.close(pi.hThread);
      k.close(pi.hProcess);
      return pi.dwProcessId as number;
    }
  }
  return null;
}
