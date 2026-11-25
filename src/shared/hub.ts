/**
 * Atelier hub wire protocol: newline-delimited JSON over a named pipe (Windows) or unix socket.
 * Every connection starts with `hello` carrying the terminal's token; the hub derives the terminal and project
 * from the token, never from what the client claims, so a session can only see its own project.
 */

import { HUB_MAX_TITLE } from './constants';
import type { ClaudeState } from './ipc';

export type HubRole = 'mcp' | 'hook';

export interface Hello {
  t: 'hello';
  token: string;
  role: HubRole;
}

export type HookEvent =
  'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification' | 'SessionEnd';

export interface HookMessage {
  t: 'hook';
  event: HookEvent;
  /** Notification hooks: permission_prompt, idle_prompt… */
  notificationType?: string;
  /** PreToolUse / PostToolUse: the tool's name. */
  tool?: string;
  /** When the hook process started (ms). Async hooks can arrive out of order; older events are ignored. */
  at: number;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string | null;
  cwd: string | null;
  claude: ClaudeState | null;
  self: boolean;
}

export interface InboxMessage {
  id: number;
  from: string;
  fromName: string;
  text: string;
  at: string;
}

export type HubRequest =
  | { t: 'req'; id: number; op: 'peers' }
  | { t: 'req'; id: number; op: 'send'; to: string; message: string }
  | { t: 'req'; id: number; op: 'inbox' }
  | { t: 'req'; id: number; op: 'read_output'; terminal: string; lines: number }
  | { t: 'req'; id: number; op: 'set_title'; title: string };

export type HubResponse =
  { t: 'res'; id: number; ok: true; result: unknown } | { t: 'res'; id: number; ok: false; error: string };

export type ClientMessage = Hello | HookMessage | HubRequest;

/** Result of `send`, one entry per recipient. */
export interface SendReport {
  to: string;
  name: string;
  status: 'delivered' | 'queued' | 'rejected';
  reason?: string;
}

/** Longest line the hub accepts (a message is at most HUB_MAX_MESSAGE characters; this leaves room for JSON). */
export const HUB_MAX_LINE = 256 * 1024;

/** Splits a stream into lines; returns the unfinished tail. */
export function splitLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n', start)) {
    const line = buffer.slice(start, i).trim();
    start = i + 1;
    if (line) onLine(line);
  }
  return buffer.slice(start);
}

/* eslint-disable no-control-regex -- terminal titles must not carry control characters */
const TITLE_CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/**
 * A terminal title as Claude sent it, made safe for the sidebar: no control characters, whitespace collapsed,
 * at most HUB_MAX_TITLE characters (code points, so an emoji is never cut in half). '' when nothing is left.
 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(TITLE_CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > HUB_MAX_TITLE ? chars.slice(0, HUB_MAX_TITLE).join('').trimEnd() : text;
}
