import { WEBGL_LRU_EXTRA, SNAPSHOT_INTERVAL_MS } from '@shared/constants';
import { api } from '../lib/api';
import { useApp } from '../state/app';
import { dropRuntime } from '../state/runtime';
import { TerminalController } from './TerminalController';

/**
 * Every terminal's controller, created on first start and kept until the terminal is closed. Controllers never
 * re-open xterm; their host elements move between pane slots and the off-screen parking area.
 */
const controllers = new Map<string, TerminalController>();
/** Most recently shown first: WebGL is kept for the visible terminals plus WEBGL_LRU_EXTRA of these. */
let recent: string[] = [];
let parking: HTMLElement | null = null;

function parkingArea(): HTMLElement {
  if (!parking) {
    parking = document.createElement('div');
    parking.className = 'term-parking';
    parking.setAttribute('aria-hidden', 'true');
    document.body.appendChild(parking);
  }
  return parking;
}

export function getController(id: string): TerminalController | undefined {
  return controllers.get(id);
}

export function allControllers(): IterableIterator<TerminalController> {
  return controllers.values();
}

function ensure(id: string): TerminalController {
  let c = controllers.get(id);
  if (!c) {
    c = new TerminalController(id, parkingArea());
    controllers.set(id, c);
  }
  return c;
}

export function startTerminal(id: string): void {
  void ensure(id).start();
}

export function restartTerminal(id: string): void {
  void ensure(id).restart();
}

export function focusTerminal(id: string): void {
  controllers.get(id)?.focus();
}

/** Closes a terminal for good: kills its shell, drops its xterm and (optionally) its snapshot. */
export function disposeTerminal(id: string, deleteSnapshot: boolean): void {
  void api.invoke('pty:kill', id);
  if (deleteSnapshot) void api.invoke('snapshot:delete', id);
  controllers.get(id)?.dispose();
  controllers.delete(id);
  recent = recent.filter((x) => x !== id);
  dropRuntime(id);
}

/** Puts a terminal in a pane slot. */
export function attachTerminal(id: string, container: HTMLElement): void {
  const c = ensure(id);
  c.attach(container);
  recent = [id, ...recent.filter((x) => x !== id)];
  c.setGpu(true);
  balanceGpu();
}

/** A pane slot lets its terminal go: parked off-screen, unless another slot has already taken it. */
export function releaseTerminal(id: string, container: HTMLElement): void {
  const c = controllers.get(id);
  if (c && c.host.parentElement === container) c.attach(null);
}

/** Keeps WebGL only for visible terminals plus a few recently shown ones (Chromium caps contexts per page). */
function balanceGpu(): void {
  const visible = [...controllers.values()].filter((c) => c.isVisible()).map((c) => c.id);
  const keep = new Set([...visible, ...recent.filter((id) => !visible.includes(id)).slice(0, WEBGL_LRU_EXTRA)]);
  for (const c of controllers.values()) if (!keep.has(c.id) && c.hasGpuSlot()) c.setGpu(false);
}

/** After a GPU process crash: turn WebGL back on where it belongs. */
export function restoreGpu(): void {
  for (const c of controllers.values()) if (c.isVisible()) c.setGpu(true);
  balanceGpu();
}

export function applySettingsToAll(): void {
  const s = useApp.getState().settings;
  for (const c of controllers.values()) c.applySettings(s);
  balanceGpu();
}

export function applyThemeToAll(): void {
  for (const c of controllers.values()) {
    c.applyTheme();
    c.repaintSoon();
  }
}

/** Saves the snapshot of every terminal that printed something since its last save. */
export async function saveSnapshots(all = false): Promise<void> {
  await Promise.all(
    [...controllers.values()]
      .filter((c) => all || c.dirty)
      .map((c) => {
        c.dirty = false;
        return api.invoke('snapshot:write', c.id, c.snapshot());
      }),
  );
}

export function startSnapshotTimer(): void {
  window.setInterval(() => void saveSnapshots(), SNAPSHOT_INTERVAL_MS);
}

/** Read-only inspection hook used by the end-to-end tests (WebGL draws text on a canvas, not in the DOM). */
declare global {
  interface Window {
    __atelier?: { ids(): string[]; text(id: string, lines?: number): string | null; gpu(id: string): boolean | null };
  }
}
window.__atelier = {
  ids: () => [...controllers.keys()],
  text: (id, lines) => controllers.get(id)?.text(lines) ?? null,
  gpu: (id) => controllers.get(id)?.hasGpu() ?? null,
};
