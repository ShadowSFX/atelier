import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Events, Invoke } from '@shared/ipc';
import { log } from './log';

type Handler<K extends keyof Invoke> = (
  ...args: Parameters<Invoke[K]>
) => ReturnType<Invoke[K]> | Promise<Awaited<ReturnType<Invoke[K]>>>;

let trustedOrigin: (url: string) => boolean = () => false;

/** Only the app's own page may call main (a navigated or injected frame never gets here anyway). */
export function setTrustedOrigin(check: (url: string) => boolean): void {
  trustedOrigin = check;
}

export function handle<K extends keyof Invoke>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!e.senderFrame || !trustedOrigin(e.senderFrame.url)) {
      log.warn('ipc from untrusted frame', channel, e.senderFrame?.url);
      throw new Error('untrusted sender');
    }
    return fn(...(args as Parameters<Invoke[K]>));
  });
}

export function send<K extends keyof Events>(win: BrowserWindow | null, channel: K, ...args: Parameters<Events[K]>): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
}
