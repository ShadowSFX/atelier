import { CODE_MODE_ENV } from './constants';
import type { StringKey } from './i18n';
import { isSessionId, pathIdentity } from './workspace';

export { isSessionId, type ClaudeSessionRef } from './workspace';

/**
 * What a new terminal starts with. Every place that offers "new terminal" (the sidebar's + menu, the command palette,
 * the empty pane) reads this list, and restoring a terminal relies only on its persisted `claude` record: adding a
 * launcher is one entry here.
 */
export type LauncherId = 'shell' | 'claude' | 'claude-code-mode';

export interface Launcher {
  id: LauncherId;
  label: StringKey;
  /** Terminal name for a new terminal of this kind (Claude renames it later with atelier_set_title). */
  name: StringKey | null;
  /** Starts Claude Code in the shell; absent = a plain shell. */
  claude?: { codeMode: boolean };
}

export const LAUNCHERS: readonly Launcher[] = [
  { id: 'shell', label: 'launch.shell', name: null },
  { id: 'claude', label: 'launch.claude', name: 'launch.claudeName', claude: { codeMode: false } },
  {
    id: 'claude-code-mode',
    label: 'launch.claudeCodeMode',
    name: 'launch.claudeCodeModeName',
    claude: { codeMode: true },
  },
];

export function launcher(id: LauncherId): Launcher {
  return LAUNCHERS.find((l) => l.id === id) ?? LAUNCHERS[0]!;
}

export { CODE_MODE_ENV };

/** The only variables a renderer may ask a shell to start with (main drops any other). */
export const LAUNCH_ENV_KEYS: readonly string[] = [CODE_MODE_ENV];

export function claudeLaunchEnv(c: { codeMode: boolean }): Record<string, string> {
  return c.codeMode ? { [CODE_MODE_ENV]: '1' } : {};
}

/** Keeps only the variables a launcher may set, with string values. */
export function filterLaunchEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object') return {};
  const out: Record<string, string> = {};
  for (const key of LAUNCH_ENV_KEYS) {
    const v = (env as Record<string, unknown>)[key];
    if (typeof v === 'string' && /^[\w.-]{0,64}$/.test(v)) out[key] = v;
  }
  return out;
}

/**
 * The command typed into the shell. Only a validated UUID is ever added, so the same text is safe in PowerShell,
 * cmd (doskey's $*), bash, zsh and WSL, and it goes through each shell's `claude` wrapper (the hub flags).
 */
export function claudeCommand(c: { sessionId: string | null }, attachId?: string | null): string {
  if (isBackgroundId(attachId)) return `claude attach ${attachId}`;
  return isSessionId(c.sessionId) ? `claude --resume ${c.sessionId}` : 'claude';
}

// ───────────── Claude Code's background sessions ─────────────

/** A running background session of Claude Code (`claude agents --json`). */
export interface BackgroundSession {
  /** Short id that `claude attach` / `claude stop` take. */
  id: string;
  sessionId: string;
  pid: number;
  idle: boolean;
}

/** A background session's short id: hex only, so it is safe to type in any shell. */
export function isBackgroundId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{6,16}$/i.test(v);
}

/**
 * The running background sessions in `claude agents --json` (Claude Code's own format, read tolerantly: anything
 * unexpected is skipped and nothing here throws). A stopped one is still listed but has no pid.
 */
export function parseBackgroundSessions(json: string): BackgroundSession[] {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: BackgroundSession[] = [];
  for (const o of list as unknown[]) {
    if (!o || typeof o !== 'object') continue;
    const e = o as Record<string, unknown>;
    if (e.kind !== 'background' || !isBackgroundId(e.id) || !isSessionId(e.sessionId)) continue;
    if (typeof e.pid !== 'number' || !Number.isInteger(e.pid) || e.pid <= 0) continue;
    out.push({ id: e.id, sessionId: e.sessionId, pid: e.pid, idle: e.status === 'idle' });
  }
  return out;
}

// ───────────── Claude Code's session files ─────────────

/** Claude Code's folder for a working directory under ~/.claude/projects: every non-alphanumeric becomes "-". */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** `child` is `root` or a folder inside it (case-insensitive on Windows, separators normalized). */
export function isInsidePath(child: string, root: string): boolean {
  const c = pathIdentity(child);
  const r = pathIdentity(root);
  if (c === r) return true;
  const sep = /^[a-z]:\\|^\\\\/i.test(r) ? '\\' : '/';
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export interface SessionMeta {
  /** custom title (/rename) > generated title > first prompt. */
  title: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
}

const MAX_TITLE = 200;

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE - 1).join('') + '…' : clean;
}

/** The text of a user message, or null when it isn't something the user typed (tool results, commands, reminders). */
function userText(message: unknown): string | null {
  const content = (message as { content?: unknown } | null)?.content;
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const part = content.find(
      (p): p is { type: 'text'; text: string } =>
        !!p &&
        typeof p === 'object' &&
        (p as { type?: unknown }).type === 'text' &&
        typeof (p as { text?: unknown }).text === 'string',
    );
    text = part?.text ?? null;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return null; // <command-name>, <system-reminder>, <local-command-…>
  return trimmed;
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      /* a line cut by the head/tail window, or not JSON */
    }
  }
  return out;
}

/**
 * What a session picker shows, from the start and the end of a transcript (files reach megabytes, so only those are
 * read). The transcript format is Claude Code's internal one: unknown lines are skipped and nothing here throws.
 */
export function parseSessionHeadTail(head: string, tail: string): SessionMeta {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: string | null = null;
  let firstPrompt: string | null = null;
  for (const o of lines(head)) {
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!startedAt && typeof o.timestamp === 'string') startedAt = o.timestamp;
    if (o.type !== 'user' || o.isMeta === true || o.isSidechain === true) continue;
    if (!gitBranch && typeof o.gitBranch === 'string' && o.gitBranch) gitBranch = o.gitBranch;
    if (!firstPrompt) {
      const text = userText(o.message);
      if (text) firstPrompt = shorten(text);
    }
  }
  let custom: string | null = null;
  let ai: string | null = null;
  // Head too: a short transcript is all head, and a title set early may have left the tail window.
  for (const o of [...lines(head), ...lines(tail)]) {
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim())
      custom = shorten(o.customTitle);
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim())
      ai = shorten(o.aiTitle);
    else if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
  }
  return { title: custom ?? ai ?? firstPrompt, firstPrompt, cwd, gitBranch, startedAt };
}

/** A session of Claude Code that can be resumed (claude:sessions). */
export interface ClaudeSessionInfo {
  id: string;
  title: string;
  cwd: string;
  gitBranch: string | null;
  /** Last write of the transcript (ms). */
  updatedAt: number;
  sizeBytes: number;
}
