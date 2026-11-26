import { execFile, type ChildProcess } from 'node:child_process';
import { parseBackgroundSessions, type BackgroundSession } from '@shared/launchers';
import { log } from '../log';

/** Runs Claude Code with `args` and resolves with its stdout (rejects on failure or timeout). */
export type ClaudeRunner = (args: string[], timeoutMs: number) => Promise<string>;

const LIST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;
/** Terminals restoring together share one `claude agents --json`. */
const LIST_REUSE_MS = 3_000;

/**
 * A runner for the claude executable. An npm install is a .cmd, which Node only starts through a shell. The timeout is
 * our own and kills the whole tree: execFile's kills only the shell on Windows, and a child still holding the output
 * pipe would keep its callback (and Atelier's wait) pending.
 */
export function claudeRunner(exe: string, env: NodeJS.ProcessEnv): ClaudeRunner {
  const shell = /\.(cmd|bat)$/i.test(exe);
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      let done = false;
      // Through a shell, one command line (Node deprecates args with shell): the arguments are fixed words and a hex
      // id (isBackgroundId), nothing to quote.
      const child = execFile(
        shell ? [`"${exe}"`, ...args].join(' ') : exe,
        shell ? [] : args,
        { windowsHide: true, env, shell, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(String(stdout));
        },
      );
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        killTree(child);
        reject(new Error(`claude ${args[0]} timed out`));
      }, timeoutMs);
    });
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Before a terminal resumes a Claude session: Claude Code refuses `--resume` for a session that is still running as a
 * background session (it outlives Atelier, with the old terminal's revoked hub token). An idle one is stopped (its
 * conversation is kept) so the terminal resumes it with a fresh hub connection; a busy one is attached to instead, so
 * its work isn't cut. `attach` is the short id to `claude attach`, or null to resume as usual.
 */
export function createResumePreparer(
  run: ClaudeRunner,
  now: () => number = Date.now,
): (sessionId: string) => Promise<{ attach: string | null }> {
  let listing: { at: number; promise: Promise<BackgroundSession[]> } | null = null;

  const list = (): Promise<BackgroundSession[]> => {
    if (listing && now() - listing.at < LIST_REUSE_MS) return listing.promise;
    const promise = run(['agents', '--json'], LIST_TIMEOUT_MS).then(parseBackgroundSessions);
    listing = { at: now(), promise };
    promise.catch(() => {
      if (listing?.promise === promise) listing = null; // a failure is not reused
    });
    return promise;
  };

  return async (sessionId) => {
    let live: BackgroundSession | undefined;
    try {
      live = (await list()).find((s) => s.sessionId === sessionId);
    } catch (err) {
      log.warn('claude agents --json failed', err);
      return { attach: null };
    }
    if (!live) return { attach: null };
    if (!live.idle) return { attach: live.id };
    try {
      await run(['stop', live.id], STOP_TIMEOUT_MS);
      return { attach: null };
    } catch (err) {
      log.warn('claude stop failed', live.id, err);
      return { attach: live.id };
    }
  };
}
