/**
 * Portable data folder (Windows single-exe build): everything Atelier writes lives in a folder next to the exe.
 * Falls back to the per-user AppData folder when the exe's folder can't be written (Program Files, read-only USB).
 */

/** Folder created next to Atelier.exe. */
export const DATA_FOLDER = 'Atelier.data';

/** What is copied from an existing AppData profile the first time the portable folder is created. */
export const MIGRATE_ITEMS = ['settings.json', 'workspace.json', 'window.json', 'snapshots'] as const;

export interface DataDirChoice {
  dir: string;
  portable: boolean;
  /** True when a portable folder was wanted but couldn't be written (data went to AppData). */
  fallback: boolean;
}

/**
 * `portableDir` is the portable folder to use (null when not running as the portable exe); `fallbackDir` is the
 * default AppData profile; `canWrite` probes a folder (creating it).
 */
export function resolveDataDir(opts: {
  portableDir: string | null;
  fallbackDir: string;
  canWrite: (dir: string) => boolean;
}): DataDirChoice {
  const { portableDir, fallbackDir, canWrite } = opts;
  if (!portableDir) return { dir: fallbackDir, portable: false, fallback: false };
  if (canWrite(portableDir)) return { dir: portableDir, portable: true, fallback: false };
  return { dir: fallbackDir, portable: false, fallback: true };
}
