import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/ipc';
import { log } from './log';
import { PortableUpdater } from './portableUpdater';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;

export interface Updater {
  /** The latest status (sent again when the page (re)loads: early statuses arrive before the window exists). */
  status(): UpdateStatus;
  /** Installs a downloaded update while quitting; `relaunch` starts the new version. */
  apply(relaunch: boolean): void;
}

/**
 * Updates from GitHub Releases. Windows: the portable Atelier.exe updates itself (PortableUpdater) — the download is
 * staged next to the exe and swapped in on "Restart" or on the next quit. Linux: only the AppImage self-updates
 * (electron-updater); .deb installs are updated by the package manager. Development builds never update.
 */
export function startUpdater(onStatus: (s: UpdateStatus) => void): Updater {
  let last: UpdateStatus = { state: 'idle' };
  const report = (s: UpdateStatus) => {
    last = s;
    onStatus(s);
  };
  const none: Updater = { status: () => last, apply: () => undefined };
  if (!app.isPackaged) return none;

  const portableExe = process.platform === 'win32' ? process.env.PORTABLE_EXECUTABLE_FILE : undefined;
  if (portableExe) {
    const updater = new PortableUpdater(portableExe, report);
    void updater.cleanup().then(() => {
      setTimeout(() => void updater.check(), FIRST_CHECK_MS);
      setInterval(() => void updater.check(), CHECK_EVERY_MS);
    });
    return { status: () => last, apply: (relaunch) => void updater.apply(relaunch) };
  }

  if (process.platform !== 'linux' || process.env.APPIMAGE === undefined) return none;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => report({ state: 'available', version: i.version }));
  autoUpdater.on('update-downloaded', (i) => report({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (err) => log.warn('update check failed', err));
  const check = () =>
    void autoUpdater.checkForUpdates().catch((err: unknown) => log.warn('update check failed', err));
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  return {
    status: () => last,
    // On a plain quit electron-updater installs by itself (autoInstallOnAppQuit).
    apply: (relaunch) => {
      if (relaunch && last.state === 'downloaded') autoUpdater.quitAndInstall(false, true);
    },
  };
}
