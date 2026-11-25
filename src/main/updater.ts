import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/ipc';
import { NSIS_UNINSTALLER } from '@shared/portable';
import { log } from './log';
import { PortableUpdater, removeInstallerLeftovers } from './portableUpdater';

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
 * staged next to the exe and swapped in on "Restart" or on the next quit; a copy installed by the old setup swaps its
 * Atelier.exe for the portable one the same way. Linux: only the AppImage self-updates
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

  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    // A copy installed by the old NSIS setup turns itself into the portable exe (see NSIS_UNINSTALLER).
    const installed = existsSync(join(dirname(process.execPath), NSIS_UNINSTALLER));
    if (!portableExe && !installed) return none;
    const updater = new PortableUpdater(portableExe ?? process.execPath, report, !portableExe);
    if (portableExe)
      void removeInstallerLeftovers(dirname(portableExe)).catch((err: unknown) =>
        log.warn('removing the old installed copy failed', err),
      );
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
