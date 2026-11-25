import { useEffect, useState } from 'react';
import { cx } from './components/Button';
import { ContextMenu } from './components/ContextMenu';
import { DialogHost, Toasts } from './components/Overlays';
import { CommandPalette } from './features/palette/CommandPalette';
import { PaneGrid } from './features/panes/PaneGrid';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { Sidebar } from './features/sidebar/Sidebar';
import { StatusBar } from './features/statusbar/StatusBar';
import { TitleBar } from './features/titlebar/TitleBar';
import { api } from './lib/api';
import { confirmDialog, saveSettings, t, useApp } from './state/app';
import {
  activeProject,
  closeTerminal,
  cycleColumn,
  cycleProject,
  cycleTerminal,
  focusedTerminalId,
  newTerminalInActive,
  pickAndAddProject,
  saveWorkspaceNow,
  splitActive,
  useWorkspace,
} from './state/workspace';
import { applySettingsToAll, applyThemeToAll, getController, restoreGpu, saveSnapshots } from './terminal/registry';
import { appShortcut, runShortcut, setShortcutRunner, type Shortcut } from './terminal/shortcuts';
import s from './App.module.css';

const SHORTCUTS: Record<Shortcut, () => void> = {
  palette: () => useApp.setState((st) => ({ paletteOpen: !st.paletteOpen })),
  'new-terminal': () => newTerminalInActive(),
  'close-terminal': () => {
    const id = focusedTerminalId();
    if (id) void closeTerminal(id);
  },
  'next-terminal': () => cycleTerminal(1),
  'prev-terminal': () => cycleTerminal(-1),
  'next-project': () => cycleProject(1),
  'prev-project': () => cycleProject(-1),
  split: splitActive,
  'next-pane': () => cycleColumn(1),
  'prev-pane': () => cycleColumn(-1),
  settings: () => useApp.setState({ settingsOpen: true }),
  'add-project': () => void pickAndAddProject(),
};

/** Wires main-process events and store reactions that are not tied to one component. */
function useAppEffects(): void {
  useEffect(() => {
    setShortcutRunner((sc) => SHORTCUTS[sc]());

    // Shortcuts when the focus is outside a terminal (inside one, the terminal's key handler runs them).
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.xterm')) return;
      const sc = appShortcut(e) ?? (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k' ? 'palette' : null);
      if (!sc) return;
      const st = useApp.getState();
      if ((st.dialog || st.settingsOpen) && sc !== 'settings') return;
      e.preventDefault();
      runShortcut(sc);
    };
    window.addEventListener('keydown', onKey);

    const offs = [
      api.on('gpu:restored', restoreGpu),
      api.on('term:read-request', (reqId, terminalId, lines) => {
        const c = getController(terminalId);
        void api.invoke('term:read-reply', reqId, c ? c.text(lines) : null);
      }),
      api.on('app:closing', () => void onClosing()),
      // Settings changed (here or from another place): every terminal follows.
      useApp.subscribe((st, prev) => {
        if (st.settings !== prev.settings) {
          applySettingsToAll();
          document.documentElement.style.setProperty('--sidebar-width', `${st.settings.sidebarWidth}px`);
        }
        if (st.dark !== prev.dark || st.settings.colorScheme !== prev.settings.colorScheme) {
          applyThemeToAll();
          syncChrome();
        }
      }),
      // A terminal's color tints its background.
      useWorkspace.subscribe((ws, prev) => {
        const before = new Map(prev.projects.flatMap((p) => p.terminals.map((x) => [x.id, x.color])));
        for (const p of ws.projects) for (const x of p.terminals) if (before.has(x.id) && before.get(x.id) !== x.color) getController(x.id)?.applyTheme();
        watchStats();
      }),
    ];
    document.documentElement.style.setProperty('--sidebar-width', `${useApp.getState().settings.sidebarWidth}px`);
    syncChrome();
    watchStats();
    return () => {
      window.removeEventListener('keydown', onKey);
      for (const off of offs) off();
    };
  }, []);
}

/** Native caption buttons follow the app theme. */
function syncChrome(): void {
  const css = getComputedStyle(document.documentElement);
  void api.invoke('window:set-chrome', {
    background: css.getPropertyValue('--bg-base').trim(),
    symbol: css.getPropertyValue('--fg-1').trim(),
  });
}

let watched = '';
/** Tells main which project and terminals are on screen (status bar figures). */
function watchStats(): void {
  const p = activeProject();
  const key = p ? `${p.path}|${p.terminals.map((x) => x.id).join(',')}` : '';
  if (key === watched) return;
  watched = key;
  void api.invoke('window:set-visible-stats', p?.path ?? null, p?.terminals.map((x) => x.id) ?? []);
}

/** Closing the window: confirm running programs, save snapshots and the workspace, then let main quit. */
async function onClosing(): Promise<void> {
  if (useApp.getState().settings.confirmCloseRunning) {
    const ids = useWorkspace.getState().projects.flatMap((p) => p.terminals.map((x) => x.id));
    const busy = ids.length ? await api.invoke('pty:busy', ids) : [];
    if (busy.length > 0) {
      const names = useWorkspace
        .getState()
        .projects.flatMap((p) => p.terminals)
        .filter((x) => busy.includes(x.id))
        .map((x) => x.name);
      const ok = await confirmDialog({ title: t('terminals.closeRunning', names.join(', ')), ok: t('common.close'), danger: true });
      if (!ok) return;
    }
  }
  try {
    await saveSnapshots(true);
    await saveWorkspaceNow();
  } finally {
    void api.invoke('app:ready-to-quit');
  }
}

function SidebarSplitter() {
  const [active, setActive] = useState(false);
  return (
    <div
      className={cx(s.splitter, active && s.splitterActive)}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const start = e.clientX;
        const width = useApp.getState().settings.sidebarWidth;
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        const move = (ev: PointerEvent) => {
          const w = Math.max(200, Math.min(480, width + ev.clientX - start));
          document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
        };
        const up = (ev: PointerEvent) => {
          setActive(false);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          void saveSettings({ sidebarWidth: Math.max(200, Math.min(480, width + ev.clientX - start)) });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

export function App() {
  useAppEffects();
  return (
    <div className={s.app}>
      <TitleBar />
      <div className={s.body}>
        <Sidebar />
        <SidebarSplitter />
        <PaneGrid />
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsDialog />
      <DialogHost />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
