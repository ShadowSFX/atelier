import type { NotifyKind } from './notify';
import type { Settings, SettingsPatch } from './settings';
import type { Profile, ShellKind } from './shell';
import type { Workspace } from './workspace';

/**
 * The single IPC contract between main and renderer.
 * - `Invoke`: renderer → main request/response (ipcRenderer.invoke).
 * - `Events`: main → renderer notifications.
 * - PTY data does not use these channels: it flows through a dedicated MessagePort (see `PtyFrame`).
 */

export interface SpawnRequest {
  terminalId: string;
  projectId: string;
  profileId: string;
  cwd: string;
  cols: number;
  rows: number;
}

export type SpawnResult =
  | { ok: true; pid: number; kind: ShellKind; distro?: string; cwd: string; cwdFallback: boolean }
  | { ok: false; error: string };

export type PasteContent =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

export interface PathInfo {
  exists: boolean;
  isDirectory: boolean;
}

/**
 * idle: the session waits for a prompt; busy: it is working; waiting: it needs an answer from the user (a
 * permission prompt, a question, plan approval); done: it finished a turn the user hasn't looked at yet.
 */
export type ClaudeState = 'idle' | 'busy' | 'waiting' | 'done';

export interface ClaudeStatus {
  terminalId: string;
  /** null = no Claude session in this terminal. */
  state: ClaudeState | null;
  queued: number;
}

export interface TerminalStats {
  terminalId: string;
  cpu: number;
  memory: number;
  /** Deepest descendant process (what the user is "running"), null when only the shell runs. */
  foreground: string | null;
}

export interface StatsSnapshot {
  cpu: number;
  memUsed: number;
  memTotal: number;
  disk: { path: string; used: number; total: number } | null;
  appMemory: number;
  terminals: TerminalStats[];
}

/**
 * available: downloading; downloaded: installs on restart or quit; manual: a newer version exists but can't be
 * installed here (the exe's folder is read-only) — `url` is where to download it.
 */
export interface UpdateStatus {
  state: 'idle' | 'available' | 'downloaded' | 'manual' | 'error';
  version?: string;
  url?: string;
}

export interface NotifyRequest {
  terminalId: string;
  kind: NotifyKind;
  title: string;
  body: string;
}

export interface Invoke {
  'app:info': () => {
    version: string;
    platform: string;
    hostname: string;
    home: string;
    locale: string;
    dev: boolean;
    /** Where settings, workspace and snapshots are kept. */
    dataDir: string;
    /** The portable exe's folder couldn't be written: data went to AppData instead. */
    dataFallback: boolean;
  };
  'workspace:load': () => Workspace;
  /** The renderer owns the live workspace; main validates, persists (debounced) and mirrors it for the hub. */
  'workspace:save': (ws: Workspace) => void;
  'settings:load': () => Settings;
  'settings:save': (patch: SettingsPatch) => Settings;
  'profiles:list': () => { profiles: Profile[]; defaultId: string };
  'pty:spawn': (req: SpawnRequest) => SpawnResult;
  'pty:kill': (terminalId: string) => void;
  /** True when the terminal runs something besides its shell (used to confirm closing). */
  'pty:busy': (terminalIds: string[]) => string[];
  'clipboard:read-paste': () => PasteContent;
  'clipboard:write-text': (text: string) => void;
  'dialog:pick-folder': (title: string) => string | null;
  'dialog:save-text': (req: { title: string; defaultName: string; text: string }) => boolean;
  'fs:info': (path: string) => PathInfo;
  'shell:open-path': (path: string) => void;
  'shell:open-external': (url: string) => void;
  'shell:beep': () => void;
  'snapshot:read': (terminalId: string) => string | null;
  'snapshot:write': (terminalId: string, data: string) => void;
  'snapshot:delete': (terminalId: string) => void;
  /** Repaints the native caption buttons (title bar overlay) for the app theme. */
  'window:set-chrome': (colors: { background: string; symbol: string }) => void;
  'window:set-visible-stats': (projectPath: string | null, terminalIds: string[]) => void;
  'claude:deliver-now': (terminalId: string) => void;
  /** The shell's own prompt came back in a terminal that had a Claude session (it ended). */
  'claude:shell-prompt': (terminalId: string) => void;
  /** The user looked at a terminal whose Claude session finished (done → idle). */
  'claude:seen': (terminalId: string) => void;
  'term:read-reply': (reqId: number, text: string | null) => void;
  /** Shows a desktop notification; false when the system can't show one. */
  'notify:show': (n: NotifyRequest) => boolean;
  /** The renderer got 'app:closing' and is handling it (it may ask the user before quitting). */
  'app:closing-ack': () => void;
  /**
   * Renderer finished flushing snapshots after 'app:closing' (or the user chose "Restart" on a downloaded update);
   * main may quit. `restart` relaunches Atelier with the update installed.
   */
  'app:ready-to-quit': (restart?: boolean) => void;
}

export interface Events {
  'app:open-project': (path: string) => void;
  'app:closing': () => void;
  'gpu:restored': () => void;
  'stats:update': (s: StatsSnapshot) => void;
  'claude:status': (s: ClaudeStatus) => void;
  /** The hub needs the text of a terminal (atelier_read_output). Reply with 'term:read-reply'. */
  'term:read-request': (reqId: number, terminalId: string, lines: number) => void;
  'update:status': (s: UpdateStatus) => void;
  /** The user clicked a desktop notification of this terminal. */
  'notify:activate': (terminalId: string) => void;
  /** The Claude session of a terminal named it (atelier_set_title). Ignored when the user named it by hand. */
  'terminal:set-title': (terminalId: string, title: string) => void;
}

/** Messages on the PTY MessagePort. */
export type PtyFrame =
  | { t: 'data'; id: string; d: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'input'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'ack'; id: string; n: number };
