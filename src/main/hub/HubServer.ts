import { randomBytes } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { HUB_MAX_READ_LINES } from '@shared/constants';
import {
  cleanTitle,
  HUB_MAX_LINE,
  splitLines,
  type ClientMessage,
  type HubRequest,
  type HubResponse,
} from '@shared/hub';
import { log } from '../log';
import type { Delivery } from './Delivery';

interface Identity {
  terminalId: string;
  projectId: string;
}

export interface HubDeps {
  delivery: Delivery;
  /** Text of a terminal's screen and scrollback (asked to the renderer, which owns xterm). */
  readOutput(terminalId: string, lines: number): Promise<string | null>;
  /** Names the terminal in the sidebar (atelier_set_title); returns what to tell Claude. */
  setTitle(terminalId: string, title: string): string;
}

function pipePath(): string {
  const id = randomBytes(8).toString('hex');
  if (process.platform === 'win32') {
    const user = userInfo().username.replace(/[^A-Za-z0-9_-]/g, '');
    return `\\\\.\\pipe\\atelier-${user}-${id}`;
  }
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `atelier-${id}.sock`);
}

/**
 * Local IPC endpoint for the Claude sessions running inside Atelier terminals (their MCP server and hooks).
 * Authentication is a random token per terminal, handed to the shell in ATELIER_TOKEN.
 */
export class HubServer {
  readonly path = pipePath();
  private readonly tokens = new Map<string, Identity>();
  private readonly byTerminal = new Map<string, string>();
  private server: Server | null = null;

  constructor(private readonly deps: HubDeps) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 256;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.path, () => resolve());
    });
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }

  stop(): void {
    this.server?.close();
    if (process.platform !== 'win32') rmSync(this.path, { force: true });
  }

  /** A new token for a terminal (re)starting; the previous one stops working. */
  issueToken(terminalId: string, projectId: string): string {
    this.revoke(terminalId);
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { terminalId, projectId });
    this.byTerminal.set(terminalId, token);
    return token;
  }

  revoke(terminalId: string): void {
    const old = this.byTerminal.get(terminalId);
    if (old) this.tokens.delete(old);
    this.byTerminal.delete(terminalId);
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    let who: Identity | null = null;
    let token = '';
    const reply = (r: HubResponse) => socket.write(JSON.stringify(r) + '\n');
    const timer = setTimeout(() => !who && socket.destroy(), 5000);

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > HUB_MAX_LINE) {
        socket.destroy();
        return;
      }
      buffer = splitLines(buffer, (line) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(line) as ClientMessage;
        } catch {
          return;
        }
        if (!who) {
          if (msg.t !== 'hello' || typeof msg.token !== 'string') return void socket.destroy();
          token = msg.token;
          who = this.tokens.get(token) ?? null;
          clearTimeout(timer);
          if (!who) return void socket.destroy();
          return;
        }
        if (!this.tokens.has(token)) return void socket.destroy(); // revoked: the terminal closed or restarted
        if (msg.t === 'hook') {
          this.deps.delivery.hook(
            who.terminalId,
            msg.event,
            msg.notificationType,
            Number(msg.at) || Date.now(),
            typeof msg.tool === 'string' ? msg.tool : undefined,
          );
          return;
        }
        if (msg.t === 'req') {
          const id = who;
          this.handle(id, msg).then(
            (result) => reply({ t: 'res', id: msg.id, ok: true, result }),
            (err: unknown) =>
              reply({
                t: 'res',
                id: msg.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
          );
        }
      });
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clearTimeout(timer));
  }

  private async handle(who: Identity, req: HubRequest): Promise<unknown> {
    const d = this.deps.delivery;
    switch (req.op) {
      case 'peers':
        return d.peers(who.projectId, who.terminalId);
      case 'send':
        return d.send(who.projectId, who.terminalId, String(req.to ?? ''), String(req.message ?? ''));
      case 'inbox':
        return d.inbox(who.terminalId);
      case 'read_output': {
        const peers = d.peers(who.projectId, who.terminalId);
        if (!peers.some((p) => p.id === req.terminal)) throw new Error('no such terminal in this project');
        const lines = Math.min(HUB_MAX_READ_LINES, Math.max(1, Math.floor(Number(req.lines) || 100)));
        const text = await this.deps.readOutput(req.terminal, lines);
        if (text === null) throw new Error('the terminal is not available');
        return text;
      }
      case 'set_title': {
        // Always the caller's own terminal: the token says which one.
        const title = cleanTitle(req.title);
        if (!title) throw new Error('the title is empty');
        return this.deps.setTitle(who.terminalId, title);
      }
      default:
        log.warn('hub: unknown op', req);
        throw new Error('unknown operation');
    }
  }
}
