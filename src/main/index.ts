// Must stay first: it sets the data folder (portable exe) before anything else asks Electron for paths.
import { dataInfo } from './dataDir';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { app, dialog, MessageChannelMain, nativeTheme, shell } from 'electron';
import { QUIT_KILL_WAIT_MS } from '@shared/constants';
import { parseSettings, type Settings } from '@shared/settings';
import { liveUsage, type ClaudeUsage } from '@shared/usage';
import { isSessionId, parseWorkspace, type Workspace } from '@shared/workspace';
import { writeClaudeFiles, type ClaudeFiles } from './claude/integration';
import { claudeRunner, createResumePreparer } from './claude/background';
import { listClaudeSessions } from './claude/sessions';
import { UsageService } from './claude/usage';
import { ClipboardService } from './clipboard';
import { Delivery } from './hub/Delivery';
import { HubServer } from './hub/HubServer';
import { handle, send, setTrustedOrigin } from './ipc';
import { log } from './log';
import { Notifier, registerAppId } from './notifier';
import { ProfileRegistry, which } from './pty/profiles';
import { baseEnv, PtyManager } from './pty/PtyManager';
import { installShellScripts } from './shell/integration';
import { repairShortcuts, setWindowAppDetails } from './shortcuts';
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

// The data folder is set by ./dataDir (ATELIER_USER_DATA for end-to-end tests, or the portable folder).
for (const note of dataInfo.notes) log.info(`data: ${note}`);
if (dataInfo.fallback) log.warn(`data: the exe's folder isn't writable, using ${dataInfo.dir}`);
// Windows shows toasts only for a registered app id. The portable exe has no Start Menu shortcut to carry one and
// unpacks to a new folder each launch, so the id is fixed and registered for the user (registerAppId).
const APP_ID = app.isPackaged ? 'com.shadowsfx.atelier' : 'com.shadowsfx.atelier.dev';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  let win: BrowserWindow | null = null;
  // Closing: the renderer asks about running programs and saves snapshots, then calls app:ready-to-quit.
  // From then on the workspace is frozen: shells dying while Atelier quits must not read as Claude sessions ending.
  let quitting = false;
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
  // End-to-end runs use a throwaway profile and leave the user's registry alone.
  if (process.platform === 'win32' && !process.env.ATELIER_USER_DATA) {
    void registerAppId(APP_ID, app.isPackaged ? 'Atelier' : 'Atelier (dev)', userData);
  }
  // The portable launcher (not the copy unpacked in %TEMP% that runs): the taskbar and shortcuts must point at it.
  const portableExe =
    process.platform === 'win32' && app.isPackaged && !process.env.ATELIER_USER_DATA
      ? (process.env.PORTABLE_EXECUTABLE_FILE ?? null)
      : null;
  if (portableExe) repairShortcuts(portableExe, APP_ID);

  // ───────────── Stores ─────────────
  const settings = new JsonStore<Settings>(join(userData, 'settings.json'), parseSettings);
  const workspace = new JsonStore<Workspace>(join(userData, 'workspace.json'), parseWorkspace);
  const snapshots = new SnapshotStore(join(userData, 'snapshots'));
  const usageStore = new JsonStore<ClaudeUsage | null>(join(userData, 'claude-usage.json'), (raw) =>
    liveUsage(raw, Date.now()),
  );
  const usage = new UsageService(usageStore, (u) => send(win, 'claude:usage', u));
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
      statusScript: join(app.getAppPath(), 'out', 'main', 'agent-status.js'),
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
    setTitle: (terminalId, title) => {
      // Main's copy of the workspace can lag the renderer's by a save; the renderer checks the lock again.
      const term = workspace
        .get()
        .projects.flatMap((p) => p.terminals)
        .find((t) => t.id === terminalId);
      if (!term || !win) return 'This terminal is no longer open.';
      if (term.nameLocked) return 'The user named this terminal by hand, so its title was kept.';
      send(win, 'terminal:set-title', terminalId, title);
      return `Title set: "${title}"`;
    },
    // The renderer owns the workspace: it records the session so the terminal resumes it after a restart.
    onSession: (terminalId, session) => !quitting && send(win, 'claude:session', terminalId, session),
    onUsage: (u) => usage.update(u),
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

  const notifier = new Notifier(
    () => win,
    () => !settings.get().notifySound,
  );
  const forget = (id: string) => {
    hub.revoke(id);
    notifier.closeFor(id);
    delivery.terminalGone(id);
  };
  ptys.on('input', (id, data) => delivery.userInput(id, data));
  // A (re)started shell has no Claude session yet, whatever ran there before.
  ptys.on('spawned', (id) => delivery.terminalGone(id));
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
  if (portableExe) setWindowAppDetails(win, portableExe, APP_ID);
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const pageUrl = devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
  setTrustedOrigin((url) => url.startsWith(devUrl ?? pageUrl.replace(/index\.html$/, '')));

  let loads = 0;
  win.webContents.on('did-finish-load', () => {
    send(win, 'update:status', updater.status());
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

  let closeAcked = false;
  win.on('close', (e) => {
    if (quitting) return;
    // A crashed page can't answer: quit directly.
    if (!win || win.webContents.isCrashed()) return;
    e.preventDefault();
    closeAcked = false;
    send(win, 'app:closing');
    // A page that is still booting or hung never answers: don't keep the window open forever.
    setTimeout(() => !closeAcked && !quitting && finishQuit(false), 3000);
  });
  /** `restart`: the user chose "Restart" on a downloaded update. A plain quit installs it too, silently. */
  const finishQuit = (restart: boolean) => {
    if (quitting) return;
    quitting = true;
    settings.flushPending();
    workspace.flushPending();
    usage.flushPending();
    usage.stop();
    killAll();
    hub.stop();
    notifier.closeAll();
    // Windows kills the shells one at a time (PtyManager.ptyQueue): the window goes now, the process once they are
    // gone (or after QUIT_KILL_WAIT_MS).
    win?.hide();
    void Promise.race([ptys.settled(), new Promise((r) => setTimeout(r, QUIT_KILL_WAIT_MS))]).then(() => {
      updater.apply(restart);
      win?.destroy();
      app.quit();
    });
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
    dataDir: dataInfo.dir,
    dataFallback: dataInfo.fallback,
  }));
  handle('workspace:load', () => workspace.get());
  handle('workspace:save', (ws) => {
    if (!quitting) workspace.set(parseWorkspace(ws));
  });
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
  handle('claude:shell-prompt', (id) => delivery.shellPrompt(id));
  handle('claude:seen', (id) => delivery.seen(id));
  handle('claude:available', () => !!(claudeExe === undefined ? (claudeExe = which('claude')) : claudeExe));
  handle('claude:usage', () => usage.current());
  handle('claude:sessions', (projectPath) =>
    typeof projectPath === 'string' && projectPath ? listClaudeSessions(projectPath) : [],
  );
  let prepareResume: ((sessionId: string) => Promise<{ attach: string | null }>) | null = null;
  handle('claude:prepare-resume', (sessionId) => {
    if (!isSessionId(sessionId)) return { attach: null };
    const exe = claudeExe === undefined ? (claudeExe = which('claude')) : claudeExe;
    if (!exe) return { attach: null };
    prepareResume ??= createResumePreparer(claudeRunner(exe, baseEnv()));
    return prepareResume(sessionId);
  });
  handle('notify:show', (n) => notifier.show(n));
  handle('term:read-reply', (id, text) => {
    readRequests.get(id)?.(text);
    readRequests.delete(id);
  });
  handle('app:closing-ack', () => void (closeAcked = true));
  handle('app:ready-to-quit', (restart) => finishQuit(restart === true));
  handle('update:check', () => updater.check());

  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));

  snapshots.prune(new Set(workspace.get().projects.flatMap((p) => p.terminals.map((t) => t.id))));
}
