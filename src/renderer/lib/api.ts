import type { AtelierApi } from '../../preload/api';
import { PTY_PORT_MESSAGE } from '../../preload/api';
import type { PtyFrame } from '@shared/ipc';

declare global {
  interface Window {
    atelier: AtelierApi;
  }
}

/** Main-process API (exposed by the preload). */
export const api: AtelierApi = window.atelier;

// ───────────── PTY data port ─────────────
// Output of every terminal arrives on one MessagePort, tagged with the terminal id.

type Listener = (frame: Extract<PtyFrame, { t: 'data' | 'exit' }>) => void;
const listeners = new Map<string, Listener>();
let port: MessagePort | null = null;
const outbox: PtyFrame[] = [];

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== PTY_PORT_MESSAGE || !e.ports[0]) return;
  port?.close();
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<PtyFrame>) => {
    const f = m.data;
    if (f.t === 'data' || f.t === 'exit') listeners.get(f.id)?.(f);
  };
  for (const f of outbox.splice(0)) port.postMessage(f);
});

export const ptyPort = {
  listen(id: string, listener: Listener): () => void {
    listeners.set(id, listener);
    return () => {
      if (listeners.get(id) === listener) listeners.delete(id);
    };
  },
  post(frame: PtyFrame): void {
    if (port) port.postMessage(frame);
    else if (frame.t !== 'ack') outbox.push(frame);
  },
};
