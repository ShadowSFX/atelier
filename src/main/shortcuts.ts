import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, shell, type BrowserWindow } from 'electron';
import { shortcutNeedsRepair } from '@shared/portable';
import { log } from './log';

/** Where Windows keeps the shortcuts that can start Atelier. Pins are named after the shortcut or exe they came from. */
function shortcutPaths(): string[] {
  const appData = app.getPath('appData');
  return [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Atelier.lnk'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Atelier.lnk'),
    join(app.getPath('desktop'), 'Atelier.lnk'),
  ];
}

/**
 * Points Atelier's shortcuts (Start Menu, taskbar pin, desktop) back at the portable exe, with its icon and app id.
 * The exe that runs is a copy unpacked to a per-launch %TEMP% folder; a shortcut that ends up pointing there (Windows
 * re-resolves links whose target was replaced) breaks at the next launch, and the taskbar shows a blank icon.
 */
export function repairShortcuts(exe: string, appId: string): void {
  for (const path of shortcutPaths()) {
    if (!existsSync(path)) continue;
    try {
      const s = shell.readShortcutLink(path);
      if (!shortcutNeedsRepair(s, exe, appId)) continue;
      const ok = shell.writeShortcutLink(path, 'update', {
        target: exe,
        cwd: dirname(exe),
        icon: exe,
        iconIndex: 0,
        appUserModelId: appId,
      });
      log.info(`shortcut ${ok ? 'repaired' : 'could not be repaired'}: ${path} (was ${s.target})`);
    } catch (err) {
      log.warn('shortcut unreadable', path, err);
    }
  }
}

/**
 * The taskbar button's identity: icon and relaunch command from the portable exe, so the button and a pin made from
 * it never refer to the temporary copy that runs.
 */
export function setWindowAppDetails(win: BrowserWindow, exe: string, appId: string): void {
  win.setAppDetails({
    appId,
    appIconPath: exe,
    appIconIndex: 0,
    relaunchCommand: `"${exe}"`,
    relaunchDisplayName: 'Atelier',
  });
}
