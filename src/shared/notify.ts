import { NOTIFY_THROTTLE_MS } from './constants';
import type { ClaudeStatus } from './ipc';
import type { Settings } from './settings';

/** Events that can raise a desktop notification. */
export type NotifyKind = 'permission' | 'question' | 'claudeDone' | 'command' | 'bell';

export const NOTIFY_KINDS: readonly NotifyKind[] = [
  'permission',
  'question',
  'claudeDone',
  'command',
  'bell',
];

/** The master switch and the event's own switch are both on. */
export function notifyEnabled(s: Settings, kind: NotifyKind): boolean {
  if (!s.notifications) return false;
  switch (kind) {
    case 'permission':
      return s.notifyPermission;
    case 'question':
      return s.notifyQuestion;
    case 'claudeDone':
      return s.notifyClaudeDone;
    case 'command':
      return s.notifyLongCommand;
    case 'bell':
      return s.notifyBell;
  }
}

type ClaudeSnapshot = Pick<ClaudeStatus, 'state' | 'asking'> | null | undefined;

/**
 * The notification a Claude state change deserves: starting to wait for the user (a permission, or an answer to a
 * question, plan approval or MCP form), a wait that turns into the other kind, or finishing a turn. A new session
 * (null → idle), the user coming back (done → idle) and a session ending (→ null) are not news.
 */
export function claudeTransition(prev: ClaudeSnapshot, next: ClaudeSnapshot): NotifyKind | null {
  const before = prev?.state ?? null;
  const after = next?.state ?? null;
  if (after === 'waiting') {
    const ask = next?.asking ?? 'permission';
    if (before === 'waiting' && (prev?.asking ?? 'permission') === ask) return null;
    return ask;
  }
  if (after === before) return null;
  if (after === 'done' && (before === 'busy' || before === 'waiting')) return 'claudeDone';
  return null;
}

/** At most one notification per terminal and kind every `windowMs`. */
export class NotifyThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs = NOTIFY_THROTTLE_MS) {}

  allow(terminalId: string, kind: NotifyKind, now: number): boolean {
    const key = `${terminalId}:${kind}`;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }

  forget(terminalId: string): void {
    for (const key of [...this.last.keys()]) if (key.startsWith(`${terminalId}:`)) this.last.delete(key);
  }
}

/** 42_000 → "42s", 185_000 → "3m 05s", 3_720_000 → "1h 02m". Negative or invalid → "0s". */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Limits on what the renderer may put in a notification. */
export const NOTIFY_MAX_TITLE = 120;
export const NOTIFY_MAX_BODY = 400;
