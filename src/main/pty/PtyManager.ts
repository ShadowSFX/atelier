import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { MessagePortMain } from 'electron';
import * as pty from 'node-pty';
import { FLOW_HIGH_WATER, FLOW_LOW_WATER, INPUT_CHUNK, PTY_BATCH_MS } from '@shared/constants';
import type { PtyFrame, SpawnRequest, SpawnResult } from '@shared/ipc';
import type { Profile } from '@shared/shell';
import { log } from '../log';
import { buildLaunch, type ShellScripts } from '../shell/integration';
import type { ProfileRegistry } from './profiles';

interface Session {
  id: string;
  projectId: string;
  profile: Profile;
  proc: pty.IPty;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  /** Characters sent to the renderer and not yet acknowledged (written by xterm). */
  unacked: number;
  paused: boolean;
  exited: boolean;
}

export interface PtyEnvProvider {
  /** Extra variables for a terminal (hub identity, claude wrapper paths), by shell kind. */
  envFor(terminalId: string, projectId: string, profile: Profile): Record<string, string>;
  claudeExe(): string | null;
  powerline(): boolean;
}

/**
 * Variables of Atelier's own process that must not leak into user shells: Electron's, Atelier's, and those that mark
 * a running Claude Code session (when Atelier itself was started from one). Claude Code's configuration variables
 * (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_GIT_BASH_PATH…) are kept.
 */
const STRIP_ENV =
  /^(ELECTRON_|ATELIER_|PORTABLE_EXECUTABLE_|CHROME_|GOOGLE_API_KEY$|NODE_OPTIONS$|VSCODE_|CLAUDECODE$|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SSE_PORT|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ID)$)/;

export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
  }
  env.TERM_PROGRAM = 'Atelier';
  env.COLORTERM = 'truecolor';
  if (process.platform !== 'win32') env.TERM = 'xterm-256color';
  return env;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Owns every shell process. Output is merged for PTY_BATCH_MS and sent through the window's MessagePort;
 * xterm acknowledges what it has written and the PTY is paused while the backlog is above FLOW_HIGH_WATER,
 * so a flood (`cat` of a huge file) never freezes the UI or grows memory without bound.
 */
export class PtyManager extends EventEmitter<{
  input: [id: string, data: string];
  exit: [id: string, code: number];
  spawned: [id: string, projectId: string];
}> {
  private readonly sessions = new Map<string, Session>();
  /** Bumped by every spawn and kill of a terminal: a spawn that was overtaken while awaiting gives up. */
  private readonly generation = new Map<string, number>();
  private port: MessagePortMain | null = null;

  constructor(
    private readonly profiles: ProfileRegistry,
    private readonly scripts: ShellScripts,
    private readonly provider: PtyEnvProvider,
  ) {
    super();
  }

  attachPort(port: MessagePortMain): void {
    this.port?.close();
    this.port = port;
    port.on('message', (e) => this.onFrame(e.data as PtyFrame));
    port.start();
    // Frames sent to a previous port will never be acknowledged.
    for (const s of this.sessions.values()) {
      s.unacked = 0;
      this.resumeIfPaused(s);
    }
  }

  private bump(id: string): number {
    const g = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, g);
    return g;
  }

  async spawn(req: SpawnRequest, defaultProfile: string): Promise<SpawnResult> {
    this.kill(req.terminalId); // a restart replaces the old process
    const gen = this.bump(req.terminalId);
    const profile =
      (await this.profiles.get(req.profileId)) ??
      (await this.profiles.get(await this.profiles.defaultId(defaultProfile)));
    // Closed or restarted while the profile was being resolved: this spawn is obsolete.
    if (this.generation.get(req.terminalId) !== gen) return { ok: false, error: 'cancelled' };
    if (!profile) return { ok: false, error: 'no-profile' };

    const wanted = req.cwd;
    const cwdFallback = !isDirectory(wanted);
    const cwd = cwdFallback ? homedir() : wanted;
    const launch = buildLaunch({
      profile,
      cwd,
      scripts: this.scripts,
      powerline: this.provider.powerline(),
      env: { ...baseEnv(), ...this.provider.envFor(req.terminalId, req.projectId, profile) },
      claudeExe: this.provider.claudeExe(),
    });

    let proc: pty.IPty;
    try {
      proc = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: Math.max(2, req.cols | 0),
        rows: Math.max(1, req.rows | 0),
        cwd: launch.cwd,
        env: launch.env,
        useConptyDll: process.platform === 'win32',
      });
    } catch (err) {
      log.error('pty spawn failed', profile.file, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const s: Session = {
      id: req.terminalId,
      projectId: req.projectId,
      profile,
      proc,
      pending: '',
      flushTimer: null,
      unacked: 0,
      paused: false,
      exited: false,
    };
    this.sessions.set(s.id, s);
    proc.onData((d) => this.onData(s, d));
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(s.id) !== s) return; // replaced by a restart
      s.exited = true;
      this.flush(s);
      this.send({ t: 'exit', id: s.id, code: exitCode });
      this.sessions.delete(s.id);
      this.emit('exit', s.id, exitCode);
    });
    this.emit('spawned', s.id, s.projectId);
    return {
      ok: true,
      pid: proc.pid,
      kind: profile.kind,
      ...(profile.distro ? { distro: profile.distro } : {}),
      cwd,
      cwdFallback,
    };
  }

  private onData(s: Session, d: string): void {
    if (this.sessions.get(s.id) !== s) return; // output of a killed or replaced process
    s.pending += d;
    s.unacked += d.length;
    if (!s.paused && s.unacked > FLOW_HIGH_WATER) {
      s.paused = true;
      s.proc.pause();
    }
    s.flushTimer ??= setTimeout(() => this.flush(s), PTY_BATCH_MS);
  }

  private flush(s: Session): void {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const d = s.pending;
    s.pending = '';
    if (!this.send({ t: 'data', id: s.id, d })) {
      // No window to receive it: don't stall the shell waiting for acks that will never come.
      s.unacked = 0;
      this.resumeIfPaused(s);
    }
  }

  private send(frame: PtyFrame): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(frame);
      return true;
    } catch {
      return false;
    }
  }

  private resumeIfPaused(s: Session): void {
    if (s.paused && s.unacked < FLOW_LOW_WATER) {
      s.paused = false;
      s.proc.resume();
    }
  }

  private onFrame(f: PtyFrame): void {
    const s = this.sessions.get(f.id);
    if (!s) return;
    switch (f.t) {
      case 'input':
        this.write(f.id, f.d);
        this.emit('input', f.id, f.d);
        break;
      case 'resize':
        if (f.cols >= 2 && f.rows >= 1 && !s.exited) {
          try {
            s.proc.resize(f.cols, f.rows);
          } catch (err) {
            log.warn('pty resize failed', err);
          }
        }
        break;
      case 'ack':
        s.unacked = Math.max(0, s.unacked - f.n);
        this.resumeIfPaused(s);
        break;
    }
  }

  /** Writes to the shell in INPUT_CHUNK pieces (a huge paste must not block the event loop in one call). */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.exited) return false;
    for (let i = 0; i < data.length; i += INPUT_CHUNK) s.proc.write(data.slice(i, i + INPUT_CHUNK));
    return true;
  }

  kill(id: string): void {
    this.bump(id);
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.flushTimer) clearTimeout(s.flushTimer);
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  pid(id: string): number | null {
    return this.sessions.get(id)?.proc.pid ?? null;
  }

  projectOf(id: string): string | null {
    return this.sessions.get(id)?.projectId ?? null;
  }

  /** Terminal ids with their shell pid. */
  pids(): Map<string, number> {
    return new Map([...this.sessions.values()].map((s) => [s.id, s.proc.pid]));
  }
}
