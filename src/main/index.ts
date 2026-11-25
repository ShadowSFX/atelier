import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow} from 'electron';
import { app, dialog, MessageChannelMain, nativeTheme, shell } from 'electron';
import { parseSettings, type Settings } from '@shared/settings';
import { parseWorkspace, type Workspace } from '@shared/workspace';
import { writeClaudeFiles, type ClaudeFiles } from './claude/integration';
import { ClipboardService } from './clipboard';
import { Delivery } from './hub/Delivery';
import { HubServer } from './hub/HubServer';
import { handle, send, setTrustedOrigin } from './ipc';
import { log } from './log';
import { ProfileRegistry, which } from './pty/profiles';
import { PtyManager } from './pty/PtyManager';
import { installShellScripts } from './shell/integration';
import { StatsService } from './stats/StatsService';
import { JsonStore } from './store/JsonStore';
import { SnapshotStore } from './store/snapshots';
import { startUpdater } from './updater';
import { createMainWindow } from './window';

process.on('uncaughtException', (err) => log.error('uncaught', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

/** A directory passed on the command line (`atelier <dir>`), resolved against the caller's directory. */
function directoryArg(argv: string[], cwd: string): string | null {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  for (let i = args.length - 1; i >= 0; i--) {
    const p = resolve(cwd, args[i]!);
    try {
      if (existsSync(p) && statSync(p).isDirectory() && p !== resolve(app.getAppPath())) return p;
    } catch {
      /* not a path */
    }
  }
  return null;
}

// End-to-end tests run against a throwaway profile (never the user's projects).
if (process.env.ATELIER_USER_DATA) app.setPath('userData', process.env.ATELIER_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  let win: BrowserWindow | null = null;
  let pendingOpen = directoryArg(process.argv, process.cwd());

  app.on('second-instance', (_e, argv, cwd) => {
    const dir = directoryArg(argv, cwd);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (dir) send(win, 'app:open-project', dir);
    }
  });

  await app.whenReady();
  const userData = app.getPath('userData');

  // ───────────── Stores ─────────────
  const settings = new JsonStore<Settings>(join(userData, 'settings.json'), parseSettings);
  const workspace = new JsonStore<Workspace>(join(userData, 'workspace.json'), parseWorkspace);
  const snapshots = new SnapshotStore(join(userData, 'snapshots'));
  const clipboard = new ClipboardService(join(userData, 'pastes'));
  clipboard.cleanup();
  nativeTheme.themeSource = settings.get().theme;

  // ───────────── Shells, hub, PTYs ─────────────
  const profiles = new ProfileRegistry();
  void profiles.list(); // detect while the window loads
  const scripts = installShellScripts(join(userData, 'shell'));
  let claudeFiles: ClaudeFiles | null = null;
  try {
    claudeFiles = writeClaudeFiles(join(userData, 'claude'), {
      exec: process.execPath,
      hookScript: join(app.getAppPath(), 'out', 'main', 'agent-hook.js'),
      mcpScript: join(app.getAppPath(), 'out', 'main', 'agent-mcp.js'),
    });
  } catch (err) {
    log.error('claude integration files', err);
  }
  let claudeExe: string | null | undefined;

  const readRequests = new Map<number, (text: string | null) => void>();
  let nextRead = 1;

  const delivery = new Delivery({
    peersOf: (projectId) => {
      const project = workspace.get().projects.find((p) => p.id === projectId);
      if (!project) return [];
      return project.terminals
        .filter((t) => ptys.has(t.id))
        .map((t) => ({ id: t.id, name: t.name, color: t.color, cwd: t.lastCwd }));
    },
    write: (id, data) => ptys.write(id, data),
    onStatus: (s) => send(win, 'claude:status', s),
    now: () => Date.now(),
  });

  const hub = new HubServer({
    delivery,
    readOutput: (terminalId, lines) =>
      new Promise((resolveText) => {
        if (!win) return resolveText(null);
        const id = nextRead++;
        const timer = setTimeout(() => {
          readRequests.delete(id);
          resolveText(null);
        }, 3000);
        readRequests.set(id, (text) => {
          clearTimeout(timer);
          resolveText(text);
        });
        send(win, 'term:read-request', id, terminalId, lines);
      }),
  });
  let hubReady = false;
  try {
    await hub.start();
    hubReady = true;
  } catch (err) {
    log.error('hub failed to start', err);
  }

  const ptys = new PtyManager(profiles, scripts, {
    envFor: (terminalId, projectId, profile) => {
      const env: Record<string, string> = { ATELIER: '1' };
      if (!hubReady) return env;
      Object.assign(env, {
        ATELIER_HUB: hub.path,
        ATELIER_PROJECT: projectId,
        ATELIER_TERMINAL: terminalId,
        ATELIER_TOKEN: hub.issueToken(terminalId, projectId),
      });
      if (settings.get().claudeHub && claudeFiles) {
        const wsl = profile.kind === 'wsl';
        env.ATELIER_CLAUDE_SETTINGS = wsl ? claudeFiles.settingsWsl : claudeFiles.settings;
        env.ATELIER_CLAUDE_MCP = wsl ? claudeFiles.mcpWsl : claudeFiles.mcp;
      }
      return env;
    },
    claudeExe: () => (claudeExe === undefined ? (claudeExe = which('claude')) : claudeExe),
    powerline: () => settings.get().powerlinePrompt,
  });

  const forget = (id: string) => {
    hub.revoke(id);
    delivery.terminalGone(id);
  };
  ptys.on('input', (id, data) => delivery.userInput(id, data));
  ptys.on('exit', (id) => forget(id));
  const killTerminal = (id: string) => {
    ptys.kill(id);
    forget(id);
  };
  const killAll = () => {
    for (const id of ptys.pids().keys()) killTerminal(id);
  };

  const stats = new StatsService(
    () => ptys.pids(),
    (s) => send(win, 'stats:update', s),
  );
  const updater = startUpdater((s) => send(win, 'update:status', s));

  // ───────────── Window ─────────────
  const dark = nativeTheme.shouldUseDarkColors;
  win = createMainWindow(userData, dark);
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const pageUrl = devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  setTrustedOrigin((url) => url.startsWith(devUrl ?? pageUrl.replace(/index\.html$/, '')));

  let loads = 0;
  win.webContents.on('did-finish-load', () => {
    // A reload loses every xterm: the renderer starts its terminals again from the workspace.
    if (loads++ > 0) killAll();
    const { port1, port2 } = new MessageChannelMain();
    ptys.attachPort(port1);
    win?.webContents.postMessage('pty:port', null, [port2]);
    if (pendingOpen) {
      send(win, 'app:open-project', pendingOpen);
      pendingOpen = null;
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log.error('renderer gone', d.reason);
    if (d.reason !== 'clean-exit') win?.webContents.reload();
  });
  const visibility = () => stats.setActive(!!win && win.isVisible() && !win.isMinimized());
  win.on('show', visibility);
  win.on('hide', visibility);
  win.on('minimize', visibility);
  win.on('restore', visibility);
  visibility();

  app.on('child-process-gone', (_e, d) => {
    if (d.type === 'GPU') {
      log.warn('GPU process gone', d.reason);
      setTimeout(() => send(win, 'gpu:restored'), 1500);
    }
  });

  // Closing: the renderer asks about running programs and saves snapshots, then calls app:ready-to-quit.
  let quitting = false;
  win.on('close', (e) => {
    if (quitting) return;
    // A crashed page can't answer: quit directly.
    if (!win || win.webContents.isCrashed()) return;
    e.preventDefault();
    send(win, 'app:closing');
  });
  const finishQuit = () => {
    quitting = true;
    settings.flushPending();
    workspace.flushPending();
    killAll();
    hub.stop();
    win?.destroy();
    app.quit();
  };
  app.on('window-all-closed', () => app.quit());

  // ───────────── IPC ─────────────
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    home: homedir(),
    locale: app.getLocale(),
    dev: !app.isPackaged,
  }));
  handle('workspace:load', () => workspace.get());
  handle('workspace:save', (ws) => workspace.set(parseWorkspace(ws)));
  handle('settings:load', () => settings.get());
  handle('settings:save', (patch) => {
    const next = parseSettings({ ...settings.get(), ...patch });
    settings.set(next);
    nativeTheme.themeSource = next.theme;
    return next;
  });
  handle('profiles:list', async () => ({
    profiles: await profiles.list(),
    defaultId: await profiles.defaultId(settings.get().defaultProfile),
  }));
  handle('pty:spawn', (req) => ptys.spawn(req, settings.get().defaultProfile));
  handle('pty:kill', (id) => killTerminal(id));
  handle('pty:busy', (ids) => stats.busy(ids));
  handle('clipboard:read-paste', () => clipboard.read());
  handle('clipboard:write-text', (text) => clipboard.writeText(text));
  handle('dialog:pick-folder', async (title) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('dialog:save-text', async ({ title, defaultName, text }) => {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath: defaultName });
    if (r.canceled || !r.filePath) return false;
    writeFileSync(r.filePath, text, 'utf8');
    return true;
  });
  handle('fs:info', (path) => {
    try {
      const s = statSync(path);
      return { exists: true, isDirectory: s.isDirectory() };
    } catch {
      return { exists: false, isDirectory: false };
    }
  });
  handle('shell:open-path', (path) => void shell.openPath(path));
  handle('shell:open-external', (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  handle('shell:beep', () => shell.beep());
  handle('snapshot:read', (id) => snapshots.read(id));
  handle('snapshot:write', (id, data) => snapshots.write(id, data));
  handle('snapshot:delete', (id) => snapshots.delete(id));
  handle('window:set-chrome', ({ background, symbol }) => {
    if (process.platform !== 'darwin') win?.setTitleBarOverlay({ color: background, symbolColor: symbol });
    win?.setBackgroundColor(background);
  });
  handle('window:set-visible-stats', (path, ids) => stats.watch(path, ids));
  handle('claude:deliver-now', (id) => delivery.flush(id, true));
  handle('term:read-reply', (id, text) => {
    readRequests.get(id)?.(text);
    readRequests.delete(id);
  });
  handle('update:install', () => {
    quitting = true;
    settings.flushPending();
    workspace.flushPending();
    killAll();
    updater.install();
  });
  handle('app:ready-to-quit', () => finishQuit());

  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));

  snapshots.prune(new Set(workspace.get().projects.flatMap((p) => p.terminals.map((t) => t.id))));
}
