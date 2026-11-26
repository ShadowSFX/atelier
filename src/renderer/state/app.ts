import { create } from 'zustand';
import { resolveLang, translate, type Lang, type StringKey } from '@shared/i18n';
import type { UpdateStatus } from '@shared/ipc';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@shared/settings';
import type { Profile } from '@shared/shell';
import { api } from '../lib/api';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  run?: () => void;
  /** Rendered instead of a row (e.g. a color swatch strip). */
  custom?: React.ReactNode;
}
export type MenuEntry = MenuItem | 'separator';

export interface Dialog {
  kind: 'confirm' | 'prompt';
  title: string;
  body?: string;
  value?: string;
  ok: string;
  danger?: boolean;
  resolve: (result: string | boolean | null) => void;
}

interface AppState {
  ready: boolean;
  platform: string;
  hostname: string;
  home: string;
  version: string;
  locale: string;
  lang: Lang;
  dark: boolean;
  settings: Settings;
  profiles: Profile[];
  defaultProfileId: string;
  update: UpdateStatus;
  toasts: Toast[];
  menu: { x: number; y: number; items: MenuEntry[] } | null;
  dialog: Dialog | null;
  paletteOpen: boolean;
  /** "Resume a Claude session" picker. */
  sessionsOpen: boolean;
  /** Claude Code is on Atelier's PATH (null = not asked yet): the + menu disables its Claude entries otherwise. */
  claudeAvailable: boolean | null;
  settingsOpen: boolean;
  /** Terminal being dragged from the sidebar (panes show their drop zones). */
  dragTerminalId: string | null;
}

export const useApp = create<AppState>(() => ({
  ready: false,
  platform: 'win32',
  hostname: '',
  home: '',
  version: '',
  locale: 'en',
  lang: 'en',
  dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  settings: DEFAULT_SETTINGS,
  profiles: [],
  defaultProfileId: '',
  update: { state: 'idle' },
  toasts: [],
  menu: null,
  dialog: null,
  paletteOpen: false,
  sessionsOpen: false,
  claudeAvailable: null,
  settingsOpen: false,
  dragTerminalId: null,
}));

/** Translation with the current language (outside React: reads the store directly). */
export function t(key: StringKey, ...args: (string | number)[]): string {
  return translate(useApp.getState().lang, key, ...args);
}

/** Translation hook: re-renders when the language changes. */
export function useT(): (key: StringKey, ...args: (string | number)[]) => string {
  const lang = useApp((s) => s.lang);
  return (key, ...args) => translate(lang, key, ...args);
}

export async function loadApp(): Promise<void> {
  const [info, settings, profiles] = await Promise.all([
    api.invoke('app:info'),
    api.invoke('settings:load'),
    api.invoke('profiles:list'),
  ]);
  useApp.setState({
    platform: info.platform,
    hostname: info.hostname,
    home: info.home,
    version: info.version,
    locale: info.locale,
    lang: resolveLang(settings.language, info.locale),
    settings,
    profiles: profiles.profiles,
    defaultProfileId: profiles.defaultId,
  });
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => useApp.setState({ dark: e.matches }));
  api.on('update:status', onUpdateStatus);
  if (info.dataFallback) toast(t('data.notPortable', info.dataDir), 'error');
}

let manualCheck = false;

/** "Check for updates" (Settings, palette): the outcome is shown in a toast as well as in the status bar. */
export function checkForUpdates(): void {
  manualCheck = true;
  void api.invoke('update:check');
}

function onUpdateStatus(update: UpdateStatus): void {
  useApp.setState({ update });
  if (!manualCheck || update.state === 'checking') return;
  manualCheck = false;
  if (update.state === 'current') toast(t('update.current', useApp.getState().version), 'success');
  else if (update.state === 'error') toast(t('update.error'), 'error');
  else if (update.state === 'unsupported') toast(t('update.unsupported'));
  else if (update.state === 'downloaded') toast(t('status.update', update.version ?? ''), 'success');
  else if (update.state === 'downloading' || update.state === 'available')
    toast(t('update.downloading', update.version ?? ''));
}

export async function saveSettings(patch: SettingsPatch): Promise<void> {
  const settings = await api.invoke('settings:save', patch);
  const s = useApp.getState();
  useApp.setState({ settings, lang: resolveLang(settings.language, s.locale) });
  if ('defaultProfile' in patch) {
    const profiles = await api.invoke('profiles:list');
    useApp.setState({ defaultProfileId: profiles.defaultId });
  }
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 3500);
}

export function dismissToast(id: number): void {
  useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

export function openMenu(x: number, y: number, items: MenuEntry[]): void {
  useApp.setState({ menu: { x, y, items } });
}

export function closeMenu(): void {
  useApp.setState({ menu: null });
}

export function confirmDialog(o: {
  title: string;
  body?: string;
  ok: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useApp.setState({ dialog: { kind: 'confirm', ...o, resolve: (r) => resolve(r === true) } });
  });
}

export function promptDialog(o: { title: string; value: string; ok: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useApp.setState({
      dialog: { kind: 'prompt', ...o, resolve: (r) => resolve(typeof r === 'string' ? r : null) },
    });
  });
}
