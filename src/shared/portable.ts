import { psQuote } from './shell';

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

/** What the update helper does once Atelier has quit (see swapScript). */
export interface SwapPlan {
  /** The portable Atelier.exe (the launcher that unpacks the app to %TEMP%). */
  exe: string;
  /** The verified download; null: nothing to swap, only relaunch. */
  staged: string | null;
  stagedVersion: string;
  old: string;
  version: string;
  /** The launcher running this Atelier: it keeps the exe open until the app exits. Null: nothing to wait for. */
  waitPid: number | null;
  relaunch: boolean;
  /** Atelier's log file, where the helper appends what happened; null: no log. */
  logFile: string | null;
}

/** How long the helper waits for the launcher to exit, then for the exe to be free (each try), in seconds. */
export const SWAP_WAIT_S = 30;
export const SWAP_RETRY_S = 10;

/**
 * PowerShell for the helper that applies a staged update to the portable exe. The launcher (electron-builder's NSIS
 * portable stub) keeps Atelier.exe open without delete sharing until the app has exited and it has removed the unpacked
 * copy, so Atelier can't rename it itself (EBUSY). The helper waits for the launcher, swaps exe → .old and .new → exe
 * (putting the old exe back if the second rename fails), and when the exe stays locked force-kills the Atelier
 * processes started from it and tries again. It relaunches Atelier last, even when the swap failed.
 */
export function swapScript(p: SwapPlan): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$exe = ${psQuote(p.exe)}`,
    `$new = ${psQuote(p.staged ?? '')}`,
    `$ver = ${psQuote(p.stagedVersion)}`,
    `$old = ${psQuote(p.old)}`,
    `$version = ${psQuote(p.version)}`,
    `$log = ${psQuote(p.logFile ?? '')}`,
    `$waitPid = ${p.waitPid ?? 0}`,
    `$relaunch = ${p.relaunch ? '$true' : '$false'}`,
    `function Write-UpdateLog([string]$m) {`,
    `  if (-not $log) { return }`,
    `  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + '] [update] ' + $m`,
    `  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}`,
    `}`,
    // '' when the swap worked, else why it didn't.
    `function Invoke-Swap {`,
    `  try { [IO.File]::Delete($old); [IO.File]::Move($exe, $old) } catch { return $_.Exception.Message }`,
    `  try { [IO.File]::Move($new, $exe) } catch {`,
    `    $err = $_.Exception.Message`,
    `    try { [IO.File]::Move($old, $exe) } catch { Write-UpdateLog ('rollback failed: ' + $_.Exception.Message) }`,
    `    return $err`,
    `  }`,
    `  try { [IO.File]::Delete($ver) } catch {}`,
    `  return ''`,
    `}`,
    `function Wait-Swap([int]$seconds) {`,
    `  $until = (Get-Date).AddSeconds($seconds)`,
    `  while ($true) {`,
    `    $err = Invoke-Swap`,
    `    if (-not $err) { return $true }`,
    `    if ((Get-Date) -gt $until) { Write-UpdateLog ('swap failed: ' + $err); return $false }`,
    `    Start-Sleep -Milliseconds 500`,
    `  }`,
    `}`,
    `if ($waitPid) { try { Wait-Process -Id $waitPid -Timeout ${SWAP_WAIT_S} -ErrorAction Stop } catch {} }`,
    `if ($new -and [IO.File]::Exists($new)) {`,
    `  $ok = Wait-Swap ${SWAP_RETRY_S}`,
    `  if (-not $ok) {`,
    `    Write-UpdateLog 'closing the Atelier processes that keep the exe open'`,
    `    try {`,
    `      Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } |`,
    `        ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }`,
    `    } catch { Write-UpdateLog ('could not close them: ' + $_.Exception.Message) }`,
    `    $ok = Wait-Swap ${SWAP_RETRY_S}`,
    `  }`,
    `  if ($ok) { Write-UpdateLog ('updated to ' + $version) }`,
    `}`,
    `if ($relaunch) {`,
    `  try { Start-Process -FilePath $exe -ArgumentList '--updated' -WorkingDirectory ([IO.Path]::GetDirectoryName($exe)) }`,
    `  catch { Write-UpdateLog ('relaunch failed: ' + $_.Exception.Message) }`,
    `}`,
  ].join('\r\n');
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

// ───────────── Shortcuts ─────────────

/** What Atelier reads from a .lnk (a subset of Electron's ShortcutDetails). */
export interface ShortcutInfo {
  target: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

const winPath = (p: string) => p.replace(/\//g, '\\').toLowerCase();
const baseName = (p: string) => winPath(p).split('\\').pop() ?? '';

/**
 * A shortcut is Atelier's when it carries Atelier's app id (the 0.1.0 setup's Start Menu entry) or starts an
 * Atelier.exe (a pin or a hand-made shortcut). Anything else is left alone.
 */
export function isAtelierShortcut(s: ShortcutInfo, appId: string): boolean {
  return s.appUserModelId === appId || baseName(s.target) === 'atelier.exe';
}

/**
 * An Atelier shortcut that doesn't start the portable exe, or takes its icon from somewhere else. Windows matches the
 * taskbar button to the shortcut with the window's app id and shows that shortcut's icon: one re-pointed at a copy
 * unpacked in %TEMP% (a per-launch folder, deleted on exit) shows a blank one.
 */
export function shortcutNeedsRepair(s: ShortcutInfo, exe: string, appId: string): boolean {
  if (!isAtelierShortcut(s, appId)) return false;
  return (
    winPath(s.target) !== winPath(exe) ||
    !s.icon ||
    winPath(s.icon) !== winPath(exe) ||
    (s.iconIndex ?? 0) !== 0 ||
    s.appUserModelId !== appId
  );
}
