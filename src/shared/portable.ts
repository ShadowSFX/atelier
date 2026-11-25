/**
 * Portable data folder (Windows single-exe build): everything Atelier writes lives in a folder next to the exe.
 * Falls back to the per-user AppData folder when the exe's folder can't be written (Program Files, read-only USB).
 */

/** Folder created next to Atelier.exe. */
export const DATA_FOLDER = 'Atelier.data';

/** What is copied from an existing AppData profile the first time the portable folder is created. */
export const MIGRATE_ITEMS = ['settings.json', 'workspace.json', 'window.json', 'snapshots'] as const;

/**
 * Atelier 0.1.0 shipped as an NSIS setup (per user, in %LOCALAPPDATA%\Programs\atelier). Every release still
 * publishes that setup + latest.yml so those copies update themselves; the installed version then replaces its own
 * Atelier.exe with the portable one (same path: shortcuts keep working) and the portable exe removes the rest.
 */
export const NSIS_UNINSTALLER = 'Uninstall Atelier.exe';
/** electron-builder's GUID for appId com.shadowsfx.atelier (UUID v5): names the setup's registry keys. */
export const NSIS_GUID = 'cddcd890-f17a-5c91-ad60-14a0f658b8ee';
export const NSIS_UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_GUID}`;
export const NSIS_APP_KEY = `HKCU\\Software\\${NSIS_GUID}`;

const LEFTOVER_DIRS = new Set(['resources', 'locales']);
const LEFTOVER_FILES = new Set(['license.electron.txt', 'licenses.chromium.html', 'vk_swiftshader_icd.json']);
const LEFTOVER_EXT = /\.(dll|pak|bin|dat)$/i;

/**
 * What the old setup installed next to Atelier.exe (Electron's runtime files), from a listing of that folder. Never
 * Atelier.exe (now the portable one), its update files, Atelier.data or the uninstaller (removed last, by the caller).
 */
export function installerLeftovers(names: readonly string[]): string[] {
  return names.filter((n) => {
    const l = n.toLowerCase();
    return LEFTOVER_DIRS.has(l) || LEFTOVER_FILES.has(l) || LEFTOVER_EXT.test(l);
  });
}

/** A value from `reg query <key> /v <name>` output (`    Name    REG_SZ    Value`); null when it isn't there. */
export function regValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[2]!.trim();
  }
  return null;
}

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
