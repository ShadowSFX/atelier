import type { Events, Invoke } from '@shared/ipc';

/** What the preload exposes on `window.atelier` (typed for the renderer). */
export interface AtelierApi {
  invoke<K extends keyof Invoke>(channel: K, ...args: Parameters<Invoke[K]>): Promise<Awaited<ReturnType<Invoke[K]>>>;
  on<K extends keyof Events>(channel: K, listener: (...args: Parameters<Events[K]>) => void): () => void;
  /** Absolute path of a dropped File (Explorer drag & drop). Empty for non-file items. */
  pathForFile(file: File): string;
}

/** The PTY MessagePort is handed to the page with window.postMessage under this tag. */
export const PTY_PORT_MESSAGE = 'atelier:pty-port';
