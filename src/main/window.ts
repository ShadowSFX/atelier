import { join } from 'node:path';
import { BrowserWindow, screen, session, shell } from 'electron';
import { z } from 'zod';
import { JsonStore } from './store/JsonStore';

const Bounds = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(600).catch(1320),
  height: z.number().min(400).catch(820),
  maximized: z.boolean().catch(false),
});
type Bounds = z.infer<typeof Bounds>;

/** Keeps the saved bounds only if they are still visible on a connected display. */
function onScreen(b: Bounds): Bounds {
  if (b.x === undefined || b.y === undefined) return b;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x! + 100 > a.x && b.x! < a.x + a.width - 100 && b.y! >= a.y - 10 && b.y! < a.y + a.height - 60;
  });
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

export const TITLE_BAR_HEIGHT = 40;

export function createMainWindow(userData: string, dark: boolean): BrowserWindow {
  const store = new JsonStore<Bounds>(join(userData, 'window.json'), (raw) => Bounds.catch({ width: 1320, height: 820, maximized: false }).parse(raw ?? {}));
  const saved = onScreen(store.get());

  const win = new BrowserWindow({
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
    minWidth: 760,
    minHeight: 460,
    show: false,
    backgroundColor: dark ? '#15181D' : '#F1F2F6',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#15181D' : '#F1F2F6', symbolColor: dark ? '#E8EBF1' : '#191D25', height: TITLE_BAR_HEIGHT },
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Hidden or minimized windows must keep acknowledging terminal output, or the shells pause.
      backgroundThrottling: false,
    },
  });
  if (saved.maximized) win.maximize();

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    store.set(maximized ? { ...store.get(), maximized } : { ...win.getNormalBounds(), maximized });
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);
  win.on('closed', () => store.flushPending());

  // The renderer never navigates or opens windows; links go through shell:open-external.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  win.once('ready-to-show', () => win.show());
  return win;
}
