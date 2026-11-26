import type { NotifyRequest } from '@shared/ipc';
import { claudeTransition, NotifyThrottle, notifyEnabled, type NotifyKind } from '@shared/notify';
import { api } from '../lib/api';
import { t, useApp } from './app';
import { useRuntime } from './runtime';
import { findTerminal, selectTerminal } from './workspace';

const throttle = new NotifyThrottle();
/** Last time each terminal was seen with a Claude session (a long "command" that was Claude is not news). */
const claudeAt = new Map<string, number>();
/** Recent requests, for the end-to-end tests (window.__atelier.notifications()). */
const recent: (NotifyRequest & { shown: boolean })[] = [];

/**
 * Raises a desktop notification for a terminal when the user turned that event on. The body says where it
 * happened ("api in Atelier"), after an optional first line (the command).
 */
export function notify(terminalId: string, kind: NotifyKind, title: string, firstLine?: string): void {
  if (!notifyEnabled(useApp.getState().settings, kind)) return;
  const found = findTerminal(terminalId);
  if (!found) return;
  if (!throttle.allow(terminalId, kind, Date.now())) return;
  const where = t('notify.where', found.terminal.name, found.project.name);
  const req: NotifyRequest = {
    terminalId,
    kind,
    title,
    body: firstLine ? `${firstLine}\n${where}` : where,
  };
  const entry = { ...req, shown: false };
  recent.push(entry);
  if (recent.length > 20) recent.shift();
  void api
    .invoke('notify:show', req)
    .then((shown) => (entry.shown = shown))
    .catch(() => undefined);
}

/** A Claude session ran in this terminal at or after `since` (ms). */
export function claudeSince(terminalId: string, since: number): boolean {
  return (claudeAt.get(terminalId) ?? -Infinity) >= since;
}

/** The terminal was closed: forget its throttle and Claude marks. */
export function forgetNotifications(terminalId: string): void {
  throttle.forget(terminalId);
  claudeAt.delete(terminalId);
}

export function recentNotifications(): readonly (NotifyRequest & { shown: boolean })[] {
  return recent;
}

export function initNotifications(): void {
  useRuntime.subscribe((s, prev) => {
    if (s.claude === prev.claude) return;
    const now = Date.now();
    for (const [id, status] of Object.entries(s.claude)) {
      if (status === prev.claude[id]) continue;
      const before = prev.claude[id];
      if (status.state) claudeAt.set(id, now);
      else if (before?.state) claudeAt.set(id, now); // ended just now: still part of the running command
      const kind = claudeTransition(before, status);
      if (kind === 'permission') notify(id, kind, t('notify.permission'));
      else if (kind === 'question') notify(id, kind, t('notify.question'));
      else if (kind === 'claudeDone') notify(id, kind, t('notify.claudeDone'));
    }
  });
  api.on('notify:activate', (terminalId) => selectTerminal(terminalId));
}
