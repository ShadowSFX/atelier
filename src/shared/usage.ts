/**
 * Claude plan usage (the limits `/usage` shows), as Claude Code hands it to statusLine commands:
 * `rate_limits.five_hour` / `rate_limits.seven_day`, each `{ used_percentage: 0-100, resets_at: epoch seconds }`.
 * Only claude.ai subscribers get it, and only after a session's first API response; either window can be missing.
 */

export interface UsageWindow {
  /** 0–100. */
  usedPercentage: number;
  /** Epoch milliseconds. */
  resetsAt: number;
}

export interface ClaudeUsage {
  sevenDay: UsageWindow | null;
  fiveHour: UsageWindow | null;
  /** When Atelier received it (ms). */
  at: number;
}

/** Atelier's statusLine script: a user statusLine containing it is Atelier's own and is never chained. */
export const USAGE_STATUS_MARKER = 'agent-status';

/** Far enough to reject garbage (a reset is at most a week away). */
const MAX_AHEAD_MS = 31 * 24 * 3600_000;

function parseWindow(raw: unknown, now: number): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { used_percentage: pct, resets_at: resets } = raw as Record<string, unknown>;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  const resetsAt = Math.round(resets * 1000);
  if (resetsAt <= now || resetsAt > now + MAX_AHEAD_MS) return null;
  return { usedPercentage: Math.min(100, Math.max(0, pct)), resetsAt };
}

/** Claude Code's `rate_limits` object → usage, or null when no current window is in it. */
export function parseRateLimits(raw: unknown, now: number): ClaudeUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sevenDay = parseWindow(r.seven_day, now);
  const fiveHour = parseWindow(r.five_hour, now);
  return sevenDay || fiveHour ? { sevenDay, fiveHour, at: now } : null;
}

const liveWindow = (w: UsageWindow | null | undefined, now: number): UsageWindow | null =>
  w && Number.isFinite(w.usedPercentage) && Number.isFinite(w.resetsAt) && w.resetsAt > now
    ? { usedPercentage: Math.min(100, Math.max(0, w.usedPercentage)), resetsAt: w.resetsAt }
    : null;

/** Usage without the windows that have reset (null when none is left). Tolerates anything read from disk. */
export function liveUsage(u: unknown, now: number): ClaudeUsage | null {
  if (!u || typeof u !== 'object') return null;
  const v = u as Partial<ClaudeUsage>;
  const sevenDay = liveWindow(v.sevenDay, now);
  const fiveHour = liveWindow(v.fiveHour, now);
  if (!sevenDay && !fiveHour) return null;
  return { sevenDay, fiveHour, at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : now };
}

/** The earliest reset still ahead, or null. */
export function nextReset(u: ClaudeUsage | null): number | null {
  const times = [u?.sevenDay?.resetsAt, u?.fiveHour?.resetsAt].filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : null;
}

/** Rounded, but 100 only once the limit is reached (99.6 → 99). */
export function displayPercent(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  return p >= 100 ? 100 : Math.min(99, Math.round(p));
}

const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** When a limit resets, short (status bar): "14:00" within a day, else "Tue 14:00". */
export function resetLabel(at: number, now: number, locale: string): string {
  const opts = at - now < 24 * 3600_000 ? TIME : { weekday: 'short' as const, ...TIME };
  return new Intl.DateTimeFormat(locale, opts).format(at);
}

/** When a limit resets, for a tooltip: "Tuesday, December 2, 14:00". */
export function resetLong(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', ...TIME }).format(
    at,
  );
}

/** When a report arrived, for a tooltip: the time if it was today, else the date and time. */
export function pastMoment(at: number, now: number, locale: string): string {
  const a = new Date(at);
  const b = new Date(now);
  const today =
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return new Intl.DateTimeFormat(locale, today ? TIME : { day: 'numeric', month: 'short', ...TIME }).format(
    at,
  );
}

/**
 * The user's own statusLine command from Claude Code settings objects, highest precedence first (project local,
 * project, user). Atelier's statusLine replaces it in its sessions, so Atelier runs it after reading the usage.
 */
export function userStatusLineCommand(settings: unknown[]): string | null {
  for (const s of settings) {
    if (!s || typeof s !== 'object') continue;
    const line = (s as { statusLine?: unknown }).statusLine;
    if (!line || typeof line !== 'object') continue;
    const { type, command } = line as { type?: unknown; command?: unknown };
    // The first file that defines a statusLine wins, even if it's not one Atelier can run.
    if (type !== 'command' || typeof command !== 'string' || !command.trim()) return null;
    return command.includes(USAGE_STATUS_MARKER) ? null : command;
  }
  return null;
}
