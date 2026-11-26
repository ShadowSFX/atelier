import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promises as originalFs } from 'original-fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { app, net } from 'electron';
import type { UpdateStatus } from '@shared/ipc';
import {
  installerLeftovers,
  NSIS_APP_KEY,
  NSIS_UNINSTALL_KEY,
  NSIS_UNINSTALLER,
  regValue,
  swapScript,
  type SwapPlan,
} from '@shared/portable';
import {
  compareVersions,
  parseChecksum,
  parseRelease,
  planUpdate,
  RELEASES_API,
  RELEASES_URL,
  type UpdatePlan,
} from '@shared/update';
import { canWrite } from './dataDir';
import { startHidden } from './hiddenProcess';
import { log } from './log';

/**
 * Self-updater for the portable Windows exe (port of RDMan's UpdateService):
 * check GitHub → download next to the exe → verify SHA-256 → stage as `Atelier.exe.new` → swap on restart or quit.
 * Windows lets a running exe be renamed, which is what makes the in-place swap possible. The exe here is the
 * portable launcher (PORTABLE_EXECUTABLE_FILE), not the copy unpacked in %TEMP% that actually runs.
 *
 * `migrate`: this is a copy installed by the old NSIS setup (`exe` is its Atelier.exe). It stages the portable exe even
 * of its own version, so the swap turns the install into the portable exe; that one then removes the setup's files
 * (removeInstallerLeftovers).
 */
export class PortableUpdater {
  private readonly exe: string;
  private readonly dir: string;
  private readonly staged: string;
  private readonly stagedVersion: string;
  private readonly download: string;
  private readonly old: string;
  private readonly current = app.getVersion();
  private busy = false;
  private etag: string | null = null;
  private ready: string | null = null;

  constructor(
    exe: string,
    private readonly onStatus: (s: UpdateStatus) => void,
    private readonly migrate = false,
  ) {
    this.exe = exe;
    this.dir = dirname(exe);
    this.staged = `${exe}.new`;
    this.stagedVersion = `${exe}.new.version`;
    this.download = `${exe}.download`;
    this.old = `${exe}.old`;
  }

  /** Startup housekeeping: the previous exe, interrupted downloads, and a staged file that isn't newer than us. */
  async cleanup(): Promise<void> {
    // The previous process may still be exiting for a moment after a restart.
    await Promise.all(
      [this.old, this.download].map((f) =>
        rm(f, { force: true, maxRetries: 10, retryDelay: 200 }).catch((err: unknown) =>
          log.warn('update cleanup', err),
        ),
      ),
    );
    try {
      if (!existsSync(this.staged)) return;
      const version = existsSync(this.stagedVersion) ? readFileSync(this.stagedVersion, 'utf8').trim() : '';
      const cmp = version ? compareVersions(version, this.current) : -1;
      if (cmp > 0 || (cmp === 0 && this.migrate)) {
        this.ready = version;
        this.onStatus({ state: 'downloaded', version });
      } else {
        rmSync(this.staged, { force: true });
        rmSync(this.stagedVersion, { force: true });
      }
    } catch (err) {
      log.warn('update cleanup', err);
    }
  }

  async check(): Promise<void> {
    if (this.busy || this.ready) return;
    this.busy = true;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Atelier-Updater/${this.current}`,
      };
      if (this.etag) headers['If-None-Match'] = this.etag;
      const res = await net.fetch(RELEASES_API, { headers, cache: 'no-store' });
      if (res.status === 304 || res.status === 404) return; // unchanged, or no release yet
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const plan = planUpdate(this.current, parseRelease(await res.text()), this.migrate);
      if (!plan) {
        this.etag = res.headers.get('etag');
        return;
      }
      if (!canWrite(this.dir)) {
        log.warn(`update ${plan.release.version} available but ${this.dir} is read-only`);
        this.onStatus({
          state: 'manual',
          version: plan.release.version,
          url: plan.release.htmlUrl || RELEASES_URL,
        });
        return;
      }
      this.onStatus({ state: 'available', version: plan.release.version });
      await this.fetchUpdate(plan);
    } catch (err) {
      log.warn('update check failed', err);
    } finally {
      this.busy = false;
    }
  }

  private async fetchUpdate(plan: UpdatePlan): Promise<void> {
    const sumRes = await net.fetch(plan.checksum.url, { cache: 'no-store' });
    if (!sumRes.ok) throw new Error(`checksum download answered ${sumRes.status}`);
    const expected = parseChecksum(await sumRes.text());
    if (!expected) throw new Error('invalid checksum file');

    const res = await net.fetch(plan.exe.url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
    try {
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        createWriteStream(this.download),
      );
      const actual = await sha256(this.download);
      if (actual !== expected) throw new Error(`SHA-256 mismatch (expected ${expected}, got ${actual})`);
      renameSync(this.download, this.staged);
      writeFileSync(this.stagedVersion, plan.release.version, 'utf8');
    } catch (err) {
      rmSync(this.download, { force: true });
      throw err;
    }
    this.ready = plan.release.version;
    log.info(`update ${plan.release.version} ready`);
    this.onStatus({ state: 'downloaded', version: plan.release.version });
  }

  /**
   * Swaps the exe with the staged one (on quit, or from "Restart" with `relaunch`). Only a staged file this run
   * verified (download) or validated (cleanup) is used; a failed swap puts the old exe back so the user is never left
   * without one. `relaunch` starts Atelier again either way.
   *
   * The portable exe can't be swapped from here: its launcher keeps it open until this process has exited (EBUSY), so
   * a helper does it once Atelier is gone (swapScript) and relaunches it — which also keeps the new launcher from
   * unpacking into the %TEMP% folder the old one is about to delete. Returns whether a swap was done or handed over.
   */
  apply(relaunch: boolean): boolean {
    const pending = this.ready !== null && existsSync(this.staged);
    if (!this.migrate && (pending || relaunch) && this.applyLater(pending, relaunch)) return pending;
    const swapped = pending && this.swap();
    if (relaunch) {
      try {
        app.releaseSingleInstanceLock();
        spawn(this.exe, ['--updated'], { cwd: this.dir, detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        log.error('relaunch after update failed', err);
      }
    }
    return swapped;
  }

  /** Starts the helper that swaps (when `swap`) and relaunches after Atelier and its launcher exit. False: it didn't start. */
  private applyLater(swap: boolean, relaunch: boolean): boolean {
    const plan: SwapPlan = {
      exe: this.exe,
      staged: swap ? this.staged : null,
      stagedVersion: this.stagedVersion,
      old: this.old,
      version: this.ready ?? '',
      // The launcher started this process and waits for it (ExecWait).
      waitPid: process.ppid || null,
      relaunch,
      logFile: logFile(),
    };
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    // Not child_process.spawn: see startHidden.
    const pid = startHidden(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(swapScript(plan), 'utf16le').toString('base64'),
      ],
      this.dir,
    );
    if (pid === null) {
      log.error(`could not start the update helper (${powershell})`);
      return false;
    }
    log.info(
      `${swap ? `update ${this.ready ?? '?'}` : 'relaunch'} handed to the helper (pid ${pid}, waiting for ${plan.waitPid ?? 'nothing'})`,
    );
    return true;
  }

  private swap(): boolean {
    try {
      rmSync(this.old, { force: true });
      renameSync(this.exe, this.old);
      try {
        renameSync(this.staged, this.exe);
      } catch (err) {
        try {
          renameSync(this.old, this.exe);
        } catch (rollback) {
          log.error('update rollback failed', rollback);
        }
        throw err;
      }
      rmSync(this.stagedVersion, { force: true });
    } catch (err) {
      log.error('update swap failed', err);
      return false;
    }
    log.info(`updated ${basename(this.exe)} to ${this.ready ?? '?'}`);
    return true;
  }
}

/**
 * Run by the portable exe at startup: when its folder is an old NSIS install (the installed copy swapped itself for
 * this exe), forgets the install in the registry, so "Uninstall" can't wipe the folder with the exe and its data, and
 * deletes Electron's files. The uninstaller goes last: while anything is left (a file still locked), the next start
 * tries again.
 */
export async function removeInstallerLeftovers(dir: string): Promise<void> {
  const uninstaller = join(dir, NSIS_UNINSTALLER);
  if (!existsSync(uninstaller)) return;
  log.info(`removing the old installed copy's files from ${dir}`);
  let clean = await forgetInstall(uninstaller);
  // Electron's own fs treats resources\app.asar as a folder and keeps the archive open, so it could never be
  // deleted (EBUSY, minutes of retries on every start): original-fs sees it as the plain file it is.
  for (const name of installerLeftovers(await originalFs.readdir(dir))) {
    try {
      await originalFs.rm(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      clean = false;
      log.warn(`could not remove ${name}`, err);
    }
  }
  if (clean) await originalFs.rm(uninstaller, { force: true, maxRetries: 3, retryDelay: 200 });
}

/** Deletes the setup's registry keys when they belong to this folder. False when that failed. */
async function forgetInstall(uninstaller: string): Promise<boolean> {
  const reg = (...args: string[]) => promisify(execFile)('reg', args, { windowsHide: true });
  let uninstall: string | null;
  try {
    uninstall = regValue(
      (await reg('query', NSIS_UNINSTALL_KEY, '/v', 'UninstallString')).stdout,
      'UninstallString',
    );
  } catch {
    return true; // no such key
  }
  // Another install of Atelier (another folder) keeps its entry.
  if (!uninstall?.toLowerCase().includes(uninstaller.toLowerCase())) return true;
  try {
    await reg('delete', NSIS_UNINSTALL_KEY, '/f');
    await reg('delete', NSIS_APP_KEY, '/f').catch(() => undefined);
    log.info('removed the old setup from installed apps');
    return true;
  } catch (err) {
    log.warn('could not remove the old setup from installed apps', err);
    return false;
  }
}

function logFile(): string | null {
  try {
    return log.transports.file.getFile().path || null;
  } catch {
    return null;
  }
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
