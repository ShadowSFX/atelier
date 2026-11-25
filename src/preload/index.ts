import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Events } from '@shared/ipc';
import { PTY_PORT_MESSAGE, type AtelierApi } from './api';

const EVENTS = new Set<keyof Events>([
  'app:open-project',
  'app:closing',
  'gpu:restored',
  'stats:update',
  'claude:status',
  'term:read-request',
  'update:status',
  'notify:activate',
  'terminal:set-title',
]);

const api: AtelierApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    if (!EVENTS.has(channel)) throw new Error(`unknown event ${channel}`);
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]) =>
      (listener as (...a: unknown[]) => void)(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('atelier', api);

// The preload is type-checked with the main process (no DOM lib); it only needs these two.
declare const window: {
  postMessage(message: string, origin: string, transfer: unknown[]): void;
  location: { origin: string };
};

// MessagePorts can't cross the context bridge: hand the PTY port to the page directly.
ipcRenderer.on('pty:port', (e) => {
  window.postMessage(
    PTY_PORT_MESSAGE,
    window.location.origin === 'null' ? '*' : window.location.origin,
    e.ports,
  );
});
