import { execFile, type ChildProcess } from 'node:child_process';
import { parseBackgroundSessions, type BackgroundSession } from '@shared/launchers';
import { log } from '../log';

export interface RunOptions {
  /** Written to stdin, then stdin is closed (a prompt never goes on the command line). */
  input?: string;
  cwd?: string;
  /** Aborting kills the whole tree and rejects. */
  signal?: AbortSignal;
}

/** How a terminal starts its saved Claude session again (claude:prepare-resume). */
export interface ResumePlan {
  /** Short id to `claude attach` to (a busy background session), or null. */
  attach: string | null;
  /** Nothing to resume: start a new session instead. */
  fresh: boolean;
}

/** Runs Claude Code with `args` and resolves with its stdout (rejects on failure, timeout or abort). */
export type ClaudeRunner = (args: string[], timeoutMs: number, opts?: RunOptions) => Promise<string>;

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
  return (args, timeoutMs, opts = {}) =>
    new Promise((resolve, reject) => {
      let done = false;
      if (opts.signal?.aborted) return reject(new Error('cancelled'));
      // Through a shell, one command line (Node deprecates args with shell): the arguments are fixed words and a hex
      // id (isBackgroundId), nothing to quote.
      const child = execFile(
        shell ? [`"${exe}"`, ...args].join(' ') : exe,
        shell ? [] : args,
        {
          windowsHide: true,
          env,
          shell,
          maxBuffer: 4 * 1024 * 1024,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
        },
        (err, stdout, stderr) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
          else resolve(String(stdout));
        },
      );
      const onAbort = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        killTree(child);
        reject(new Error('cancelled'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.input !== undefined) {
        child.stdin?.on('error', () => undefined); // the process may exit before reading everything
        child.stdin?.end(opts.input, 'utf8');
      }
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
 * its work isn't cut. `attach` is the short id to `claude attach`, or null to resume as usual. `fresh`: the session
 * has no conversation to resume (opened and closed without typing anything), so a new one is started instead.
 */
export function createResumePreparer(
  run: ClaudeRunner,
  now: () => number = Date.now,
  hasConversation: (sessionId: string) => Promise<boolean | null> = async () => null,
): (sessionId: string) => Promise<ResumePlan> {
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
    // Both at once: the transcript is read while Claude Code lists its background sessions.
    const conversation = hasConversation(sessionId).catch(() => null);
    const resume = async (): Promise<ResumePlan> => ({
      attach: null,
      fresh: (await conversation) === false, // unsure (null): resume as usual
    });
    let live: BackgroundSession | undefined;
    try {
      live = (await list()).find((s) => s.sessionId === sessionId);
    } catch (err) {
      log.warn('claude agents --json failed', err);
      return resume();
    }
    if (!live) return resume();
    // Still running: Claude Code holds it, whatever its transcript says.
    if (!live.idle) return { attach: live.id, fresh: false };
    try {
      await run(['stop', live.id], STOP_TIMEOUT_MS);
      return resume();
    } catch (err) {
      log.warn('claude stop failed', live.id, err);
      return { attach: live.id, fresh: false };
    }
  };
}
