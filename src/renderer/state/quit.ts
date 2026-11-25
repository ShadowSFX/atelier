import { api } from '../lib/api';
import { saveSnapshots } from '../terminal/registry';
import { confirmDialog, t, useApp } from './app';
import { saveWorkspaceNow, useWorkspace } from './workspace';

let closing = false;

/**
 * Quitting (the window's close button, or "Restart" on a downloaded update): confirm running programs, save
 * snapshots and the workspace, then let main quit. `restart` relaunches Atelier with the update installed.
 * Cancelling the confirmation keeps everything running.
 */
export async function closeApp(restart = false): Promise<void> {
  if (closing) return; // a second click while the confirmation is open
  closing = true;
  try {
    if (useApp.getState().settings.confirmCloseRunning) {
      const ids = useWorkspace.getState().projects.flatMap((p) => p.terminals.map((x) => x.id));
      const busy = ids.length ? await api.invoke('pty:busy', ids) : [];
      if (busy.length > 0) {
        const names = useWorkspace
          .getState()
          .projects.flatMap((p) => p.terminals)
          .filter((x) => busy.includes(x.id))
          .map((x) => x.name);
        const ok = await confirmDialog({
          title: t('terminals.closeRunning', names.join(', ')),
          ok: restart ? t('status.restart') : t('common.close'),
          danger: true,
        });
        if (!ok) return;
      }
    }
    try {
      await saveSnapshots(true);
      await saveWorkspaceNow();
    } finally {
      void api.invoke('app:ready-to-quit', restart);
    }
  } finally {
    closing = false;
  }
}
