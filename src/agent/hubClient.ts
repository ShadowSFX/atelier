import { connect, type Socket } from 'node:net';
import { splitLines, type ClientMessage, type HubResponse, type HubRole } from '@shared/hub';

/** The hub of the Atelier terminal this process was started from, or null outside Atelier. */
export function hubEnv(): { path: string; token: string } | null {
  const path = process.env.ATELIER_HUB;
  const token = process.env.ATELIER_TOKEN;
  return path && token ? { path, token } : null;
}

/** A request/response connection to the hub (used by the MCP server; reconnects on demand). */
export class HubClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly env: { path: string; token: string },
    private readonly role: HubRole,
  ) {}

  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= new Promise<Socket>((resolve, reject) => {
      const s = connect(this.env.path);
      s.setEncoding('utf8');
      let buffer = '';
      s.once('connect', () => {
        s.write(
          JSON.stringify({ t: 'hello', token: this.env.token, role: this.role } satisfies ClientMessage) +
            '\n',
        );
        this.socket = s;
        this.connecting = null;
        resolve(s);
      });
      s.on('data', (chunk: string) => {
        buffer = splitLines(buffer + chunk, (line) => {
          let r: HubResponse;
          try {
            r = JSON.parse(line) as HubResponse;
          } catch {
            return;
          }
          const w = this.waiting.get(r.id);
          if (!w) return;
          this.waiting.delete(r.id);
          if (r.ok) w.resolve(r.result);
          else w.reject(new Error(r.error));
        });
      });
      const fail = (err: Error) => {
        this.connecting = null;
        this.socket = null;
        for (const w of this.waiting.values()) w.reject(new Error('Atelier hub connection closed'));
        this.waiting.clear();
        reject(err);
      };
      s.once('error', fail);
      s.once('close', () => fail(new Error('Atelier hub connection closed')));
    });
    return this.connecting;
  }

  async request<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const s = await this.open();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('Atelier did not answer in time'));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      s.write(JSON.stringify({ t: 'req', id, op, ...args }) + '\n');
    });
  }
}

/** Sends one message and closes (hooks, statusLine). Never throws; resolves when written or after the timeout. */
export function sendOnce(
  env: { path: string; token: string },
  msg: ClientMessage,
  timeoutMs = 1500,
  role: HubRole = 'hook',
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      s.destroy();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const s = connect(env.path);
    s.once('connect', () => {
      const hello: ClientMessage = { t: 'hello', token: env.token, role };
      s.end(JSON.stringify(hello) + '\n' + JSON.stringify(msg) + '\n', done);
    });
    s.once('error', done);
  });
}
