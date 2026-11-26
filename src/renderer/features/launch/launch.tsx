import {
  CodeBlock16Regular,
  History16Regular,
  Sparkle16Regular,
  WindowConsole20Regular,
} from '@fluentui/react-icons';
import { LAUNCHERS, type Launcher, type LauncherId } from '@shared/launchers';
import { api } from '../../lib/api';
import { openMenu, t, useApp, type MenuEntry } from '../../state/app';
import { activeProject, newTerminalInActive } from '../../state/workspace';
import s from './launch.module.css';

/** The icon of a launcher: the console for a shell, Claude's sparkle, and a code block for Code Mode. */
export function LauncherIcon({ id }: { id: LauncherId }) {
  if (id === 'claude') return <Sparkle16Regular />;
  if (id === 'claude-code-mode') return <CodeBlock16Regular />;
  return <WindowConsole20Regular fontSize={16} />;
}

export function ResumeIcon() {
  return <History16Regular />;
}

/** Whether Claude Code is installed, asked once (main caches the PATH lookup too). */
export async function refreshClaudeAvailable(): Promise<boolean> {
  const known = useApp.getState().claudeAvailable;
  if (known !== null) return known;
  const available = await api.invoke('claude:available').catch(() => true);
  useApp.setState({ claudeAvailable: available });
  return available;
}

export function launch(id: LauncherId): void {
  newTerminalInActive({ launcher: id });
}

export function openSessionPicker(): void {
  if (activeProject()) useApp.setState({ sessionsOpen: true, menu: null });
}

/** A launcher's label; a Claude one says so when Claude Code isn't on the PATH (WSL shells may still have it). */
export function launcherLabel(l: Launcher, available: boolean | null): string {
  return l.claude && available === false ? t('launch.notFound', t(l.label)) : t(l.label);
}

/**
 * The sidebar's + menu: what to start (a shell, Claude Code, Claude Code in Code Mode, an earlier Claude session),
 * then the shell profiles, the default one checked.
 */
export async function openLauncherMenu(x: number, y: number): Promise<void> {
  const available = await refreshClaudeAvailable();
  const { profiles, defaultProfileId } = useApp.getState();
  const items: MenuEntry[] = [
    ...LAUNCHERS.map((l) => ({
      label: launcherLabel(l, available),
      icon: <LauncherIcon id={l.id} />,
      ...(l.id === 'shell' ? { shortcut: 'Ctrl+Shift+T' } : {}),
      run: () => launch(l.id),
    })),
    { label: t('launch.resume'), icon: <ResumeIcon />, run: openSessionPicker },
  ];
  if (profiles.length > 0) {
    items.push('separator', {
      label: t('launch.profiles'),
      custom: <div className={s.caption}>{t('launch.profiles')}</div>,
    });
    for (const p of profiles) {
      items.push({
        label: p.name,
        checked: p.id === defaultProfileId,
        run: () => newTerminalInActive({ profileId: p.id }),
      });
    }
  }
  openMenu(x, y, items);
}
