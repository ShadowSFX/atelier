import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/ipc';
import { log } from './log';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Updates from GitHub Releases (configured in electron-builder.yml). Downloads in the background and installs
 * when the user restarts from the status bar chip, or on the next quit. Development builds never update.
 */
export function startUpdater(onStatus: (s: UpdateStatus) => void): { install(): void } {
  if (!app.isPackaged || (process.platform === 'linux' && process.env.APPIMAGE === undefined)) {
    // .deb installs are updated by the package manager; only AppImage self-updates on Linux.
    return { install: () => undefined };
  }
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => onStatus({ state: 'available', version: i.version }));
  autoUpdater.on('update-downloaded', (i) => onStatus({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (err) => log.warn('update check failed', err));
  const check = () => void autoUpdater.checkForUpdates().catch((err: unknown) => log.warn('update check failed', err));
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
  return { install: () => autoUpdater.quitAndInstall(false, true) };
}
