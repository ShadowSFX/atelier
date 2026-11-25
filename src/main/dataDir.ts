import { cpSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { DATA_FOLDER, MIGRATE_ITEMS, resolveDataDir } from '@shared/portable';

/**
 * Where Atelier keeps its data. Imported FIRST by index.ts: paths must be set before anything (electron-log,
 * Chromium) asks for them.
 * - `ATELIER_USER_DATA` wins (end-to-end tests use a throwaway profile).
 * - The portable Windows exe (electron-builder sets PORTABLE_EXECUTABLE_DIR) uses `<exe folder>\Atelier.data`; the
 *   first time, it copies an existing AppData profile there. A folder that can't be written falls back to AppData.
 * - Anything else (development, Linux) keeps Electron's default.
 */

export interface DataInfo {
  dir: string;
  portable: boolean;
  fallback: boolean;
  /** Messages for the log (written later: logging isn't set up yet). */
  notes: string[];
}

/** Creates the folder and writes/deletes a probe file in it (RDMan's AppPaths.ProbeWritable). */
export function canWrite(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '1');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function setDataPaths(dir: string): void {
  app.setPath('userData', dir);
  app.setAppLogsPath(join(dir, 'logs'));
  app.setPath('crashDumps', join(dir, 'Crashpad'));
}

function resolve(): DataInfo {
  const override = process.env.ATELIER_USER_DATA;
  if (override) {
    setDataPaths(override);
    return { dir: override, portable: false, fallback: false, notes: [] };
  }
  const exeDir = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR : undefined;
  const appData = app.getPath('userData');
  const portableDir = exeDir ? join(exeDir, DATA_FOLDER) : null;
  const isNew = !!portableDir && !existsSync(portableDir);
  const choice = resolveDataDir({ portableDir, fallbackDir: appData, canWrite });
  const notes: string[] = [];
  if (choice.fallback) notes.push(`portable data folder not writable, using ${appData}`);
  if (choice.portable) {
    if (isNew && existsSync(appData)) {
      for (const item of MIGRATE_ITEMS) {
        const from = join(appData, item);
        if (!existsSync(from)) continue;
        try {
          cpSync(from, join(choice.dir, item), { recursive: true, errorOnExist: false, force: false });
          notes.push(`migrated ${item} from ${appData}`);
        } catch (err) {
          notes.push(`could not migrate ${item}: ${String(err)}`);
        }
      }
    }
    setDataPaths(choice.dir);
  }
  return { dir: choice.dir, portable: choice.portable, fallback: choice.fallback, notes };
}

export const dataInfo: DataInfo = resolve();
