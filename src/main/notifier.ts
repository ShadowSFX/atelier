import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type BrowserWindow, Notification, nativeImage, type NativeImage } from 'electron';
import type { NotifyRequest } from '@shared/ipc';
import { NOTIFY_KINDS, NOTIFY_MAX_BODY, NOTIFY_MAX_TITLE } from '@shared/notify';
import { send } from './ipc';
import { log } from './log';

const ICON = join(__dirname, '../../resources/icon.png');

/**
 * Registers the app id for toasts (Windows): name and icon under HKCU\Software\Classes\AppUserModelId, the way
 * unpackaged apps without a Start Menu shortcut are identified. The icon is copied next to the data because the
 * portable exe's own files live in a temp folder that changes every launch. Best effort: failures are logged.
 */
export async function registerAppId(appId: string, displayName: string, dataDir: string): Promise<void> {
  try {
    const icon = join(dataDir, 'app-icon.png');
    const png = readFileSync(ICON);
    let size = -1;
    try {
      size = statSync(icon).size;
    } catch {
      /* not there yet */
    }
    if (size !== png.length) writeFileSync(icon, png);
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
    const run = promisify(execFile);
    for (const [name, value] of [
      ['DisplayName', displayName],
      ['IconUri', icon],
    ] as const) {
      await run('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
        windowsHide: true,
      });
    }
  } catch (err) {
    log.warn('notifications: app id registration failed', err);
  }
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Desktop notifications. One live notification per terminal and kind: a newer one replaces the older (it is
 * closed, so the system's notification center doesn't pile them up). Live notifications are kept referenced, or a
 * garbage-collected one loses its click handler. A click brings the window forward and tells the renderer which
 * terminal to show.
 */
export class Notifier {
  private readonly live = new Map<string, Notification>();
  private icon: NativeImage | undefined;

  constructor(private readonly window: () => BrowserWindow | null) {}

  show(raw: NotifyRequest): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const { terminalId, kind, title, body } = raw;
    if (
      typeof terminalId !== 'string' ||
      !terminalId ||
      typeof title !== 'string' ||
      typeof body !== 'string'
    )
      return false;
    if (!NOTIFY_KINDS.includes(kind)) return false;
    if (!Notification.isSupported()) return false;

    const key = `${terminalId}:${kind}`;
    this.live.get(key)?.close();
    this.icon ??= nativeImage.createFromPath(ICON);
    const n = new Notification({
      title: clip(title, NOTIFY_MAX_TITLE),
      // libnotify reads the body as markup: a command like `a > b && c` must show as typed.
      body:
        process.platform === 'linux'
          ? escapeMarkup(clip(body, NOTIFY_MAX_BODY))
          : clip(body, NOTIFY_MAX_BODY),
      silent: false,
      ...(this.icon.isEmpty() ? {} : { icon: this.icon }),
    });
    const drop = () => {
      if (this.live.get(key) === n) this.live.delete(key);
    };
    n.on('click', () => {
      drop();
      const win = this.window();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      send(win, 'notify:activate', terminalId);
    });
    n.on('close', drop);
    n.on('failed', (_e, error) => {
      drop();
      log.warn('notification failed', error);
    });
    this.live.set(key, n);
    n.show();
    return true;
  }

  /** The terminal is gone: its notifications would open nothing. */
  closeFor(terminalId: string): void {
    for (const [key, n] of [...this.live]) {
      if (key.startsWith(`${terminalId}:`)) {
        this.live.delete(key);
        n.close();
      }
    }
  }

  closeAll(): void {
    for (const n of this.live.values()) n.close();
    this.live.clear();
  }
}
