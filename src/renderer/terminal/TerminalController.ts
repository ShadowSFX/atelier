import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { ProgressAddon } from '@xterm/addon-progress';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IMarker } from '@xterm/xterm';
import { ACK_INTERVAL_MS, LAUNCH_FALLBACK_MS } from '@shared/constants';
import type { PtyFrame } from '@shared/ipc';
import { claudeCommand, claudeLaunchEnv } from '@shared/launchers';
import { formatDuration } from '@shared/notify';
import type { Settings } from '@shared/settings';
import { isLocalOscHost, parseOsc7, quotePaths, shellPathToNative, type ShellKind } from '@shared/shell';
import { api, ptyPort } from '../lib/api';
import { confirmDialog, openMenu, t, toast, useApp } from '../state/app';
import { claudeSince, notify } from '../state/notifications';
import { patchRuntime, runtimeOf, useRuntime } from '../state/runtime';
import { endClaudeSession, findTerminal, setLastCwd, terminalWithSession } from '../state/workspace';
import { appShortcut, runShortcut } from './shortcuts';
import { terminalTheme } from './theme';

const FONT_FALLBACK =
  '"Cascadia Code NF", "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const fontFamily = (family: string) => `"${family}", ${FONT_FALLBACK}`;

/** Fonts must be loaded before xterm measures cells and builds its glyph atlas (else it caches fallback metrics). */
async function loadFonts(size: number, family: string): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`${size}px "${family}"`),
      document.fonts.load(`${size}px "Cascadia Code NF"`),
      document.fonts.load(`italic ${size}px "Cascadia Code NF"`),
      document.fonts.load(`bold ${size}px "Cascadia Code NF"`),
    ]);
  } catch {
    /* use what is available */
  }
}

export interface SearchState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  resultIndex: number;
  resultCount: number;
}

type Listener = () => void;

/**
 * One terminal: an xterm instance (created once, never re-opened) bound to a shell through the PTY port.
 * Ported from RDMan's bridge.js, one object per terminal instead of one page per terminal.
 *
 * Rendering correctness (the "stale text" glitch of other terminals): the host element moves between pane slots
 * and an off-screen parking area; every time it becomes visible it is refit, its glyph atlas is cleared and every
 * row repainted. WebGL contexts are a scarce resource in one page, so the registry only keeps them for visible and
 * recently shown terminals (see `setGpu`).
 */
export class TerminalController {
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon({ highlightLimit: 2000 });
  private readonly serializer = new SerializeAddon();
  private webgl: WebglAddon | null = null;
  /** The registry gave this terminal a WebGL slot (it is visible or recently shown). */
  private gpuSlot = false;
  private opened = false;
  private disposed = false;
  private started = false;
  private visible = false;
  private kind: ShellKind = 'other';
  private distro: string | undefined;
  private pendingAck = 0;
  private ackTimer = 0;
  private resizeTimer = 0;
  private lastSize = '';
  private zoom = 0;
  private baseFontSize = 13;
  private unlisten: (() => void) | null = null;
  private readonly prompts: { marker: IMarker; exit: number | null }[] = [];
  /** End of the last prompt (OSC 133;B): the command the user types starts here. */
  private promptEnd: { marker: IMarker; x: number } | null = null;
  /**
   * The command running now (from Enter or OSC 133;C to OSC 133;D). interactive = it used the alternate screen;
   * interrupted = the user pressed Ctrl+C meanwhile (they are there and stopped it themselves).
   */
  private command: { start: number; interactive: boolean; interrupted: boolean } | null = null;
  /** A launcher's command (`claude --resume …`), typed once the new shell shows its prompt (OSC 133;B). */
  private pendingRun: string | null = null;
  private runTimer = 0;
  /** The current shell has shown its prompt (OSC 133;B) at least once. */
  private promptSeen = false;
  /** Counts spawns, so an await in one can tell that a newer one (restart) overtook it. */
  private spawnGen = 0;
  /** The launch command was typed: the next shell prompt (OSC 133;A) means it ended. */
  private launched = false;
  private readonly listeners = new Set<Listener>();
  private readonly observer: ResizeObserver;
  /** Output since the last snapshot save. */
  dirty = false;
  searchState: SearchState = {
    open: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    resultIndex: -1,
    resultCount: 0,
  };

  constructor(
    readonly id: string,
    private readonly parking: HTMLElement,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'term-host';
    this.host.dataset.terminal = id;
    parking.appendChild(this.host);

    const s = useApp.getState().settings;
    this.baseFontSize = s.fontSize;
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: fontFamily(s.fontFamily),
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      fontWeight: s.fontWeight as 400,
      fontWeightBold: s.fontWeightBold as 700,
      cursorStyle: s.cursor,
      cursorBlink: s.cursorBlink,
      cursorInactiveStyle: 'outline',
      scrollback: s.scrollback,
      wordSeparator: s.wordSeparators,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: false,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      overviewRuler: { width: 8 },
      windowsPty: useApp.getState().platform === 'win32' ? { backend: 'conpty' } : undefined,
      linkHandler: {
        activate: (e, uri) => {
          if (e.ctrlKey) void api.invoke('shell:open-external', uri);
        },
        allowNonHttpProtocols: false,
      },
    });
    this.applyTheme();

    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey) void api.invoke('shell:open-external', uri);
      }),
    );
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new ImageAddon({ sixelSizeLimit: 25_000_000, storageLimit: 64 }));
    // OSC 52: programs may set the clipboard; reading it is never allowed.
    this.term.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => '',
        writeText: (_sel, text) => void api.invoke('clipboard:write-text', text),
      }),
    );
    const progress = new ProgressAddon();
    this.term.loadAddon(progress);
    progress.onChange((p) => patchRuntime(this.id, { progress: { state: p.state, value: p.value } }));

    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.input(d));
    this.term.onTitleChange((title) => patchRuntime(this.id, { title }));
    this.term.onBell(() => this.bell());
    this.term.buffer.onBufferChange((b) => {
      if (b.type === 'alternate' && this.command) this.command.interactive = true;
    });
    this.term.onSelectionChange(() => {
      if (useApp.getState().settings.copyOnSelect && this.term.hasSelection()) void this.copy(false);
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.search.onDidChangeResults((r) => {
      this.searchState = {
        ...this.searchState,
        resultIndex: r?.resultIndex ?? -1,
        resultCount: r?.resultCount ?? 0,
      };
      this.notify();
    });
    this.registerShellIntegration();

    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.host);
    this.host.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.host.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.host.addEventListener('dragover', (e) => this.onDragOver(e));
    this.host.addEventListener('drop', (e) => void this.onDrop(e));
    // Focusing the terminal is looking at it: a Claude turn that finished is no longer news (done → idle).
    this.host.addEventListener('focusin', () => {
      if (useRuntime.getState().claude[this.id]?.state === 'done') void api.invoke('claude:seen', this.id);
    });
    this.host.addEventListener(
      'paste',
      (e) => {
        // Every paste goes through Atelier (files, images, multi-line guard).
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.paste();
      },
      true,
    );
  }

  // ───────────── Lifecycle ─────────────

  /** Opens xterm in its host once fonts are ready. */
  private async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    const s = useApp.getState().settings;
    await loadFonts(s.fontSize, s.fontFamily);
    if (this.disposed) return;
    this.term.open(this.host);
    this.setGpu(this.gpuSlot);
    this.fitNow(true);
  }

  /** Starts the shell (once; `restart` replaces it). Restores the last snapshot above the new prompt. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.open();
    const snapshot = await api.invoke('snapshot:read', this.id);
    if (this.disposed) return;
    if (snapshot) {
      await this.resetForShell(snapshot + `\r\n\x1b[2m── ${t('term.restored')} ──\x1b[0m\r\n`);
      if (this.disposed) return;
    }
    await this.spawn();
  }

  /**
   * Writes `prefix`, then leaves the screen the way a new shell expects it: ConPTY 1.23 (useConptyDll) neither clears
   * nor homes the cursor when it starts, it assumes a blank screen with the cursor at (1,1) and later places text
   * with absolute positions. The viewport goes to scrollback (ED 2 with scrollOnEraseInDisplay, which measures the
   * rows when parsed, so a resize meanwhile can't leave old lines on screen) and the cursor goes home.
   */
  private resetForShell(prefix = ''): Promise<void> {
    this.term.options.scrollOnEraseInDisplay = true;
    return new Promise((resolve) =>
      this.term.write(prefix + '\x1b[0m\x1b[2J\x1b[H', () => {
        this.term.options.scrollOnEraseInDisplay = false;
        resolve();
      }),
    );
  }

  private async spawn(): Promise<void> {
    const found = findTerminal(this.id);
    if (!found) return;
    const { project, terminal } = found;
    this.unlisten?.();
    this.unlisten = ptyPort.listen(this.id, (f) => this.onFrame(f));
    this.command = null; // a new shell runs nothing yet
    // A terminal whose Claude session was running (a launcher, or a restart/crash of Atelier) starts it again.
    let claude = terminal.claude?.active ? terminal.claude : null;
    // Never one session in two terminals (both would write its transcript): only the first terminal resumes it.
    const owner = claude?.sessionId ? terminalWithSession(claude.sessionId) : null;
    if (claude && owner && owner.id !== this.id) {
      endClaudeSession(this.id);
      claude = null;
    }
    clearTimeout(this.runTimer);
    this.pendingRun = null;
    this.launched = false;
    this.promptSeen = false;
    const gen = ++this.spawnGen;
    // Alongside the shell's start: a session still running in Claude Code's background can't be resumed as is.
    // A session nobody typed into has nothing to resume (`claude --resume` would refuse it): a new one starts.
    const none = { attach: null, fresh: false };
    const prepared: Promise<{ attach: string | null; fresh: boolean }> = claude?.sessionId
      ? api.invoke('claude:prepare-resume', claude.sessionId).catch(() => none)
      : Promise.resolve(none);
    patchRuntime(this.id, { status: 'starting', exitCode: undefined, error: undefined, ready: false });
    const cwd = terminal.lastCwd ?? project.path;
    const r = await api.invoke('pty:spawn', {
      terminalId: this.id,
      projectId: project.id,
      profileId: terminal.profileId,
      cwd,
      cols: this.term.cols,
      rows: this.term.rows,
      ...(claude ? { env: claudeLaunchEnv(claude) } : {}),
    });
    // Closed meanwhile, or overtaken by a newer start (restart): that one reports.
    if (this.disposed || (!r.ok && r.error === 'cancelled')) return;
    if (!r.ok) {
      patchRuntime(this.id, { status: 'failed', error: r.error });
      this.term.write(`\r\n\x1b[31m${t('term.spawnFailed', terminal.name, r.error)}\x1b[0m\r\n`);
      return;
    }
    this.kind = r.kind;
    this.distro = r.distro;
    patchRuntime(this.id, { status: 'running', kind: r.kind, ...(r.distro ? { distro: r.distro } : {}) });
    if (r.cwdFallback) toast(t('term.cwdFallback', cwd), 'error');
    this.lastSize = '';
    this.fitNow(true);
    if (claude) {
      const { attach, fresh } = await prepared;
      if (this.disposed || gen !== this.spawnGen) return; // closed or restarted meanwhile
      // WSL runs its own Claude Code: Windows' background sessions and transcripts are not its own.
      const wsl = r.kind === 'wsl';
      this.pendingRun = claudeCommand(fresh && !wsl ? { sessionId: null } : claude, wsl ? null : attach);
      if (this.promptSeen) {
        // The shell's prompt came while Claude Code was being asked: type it now.
        window.setTimeout(() => this.runPending(), 0);
      } else {
        // A shell without integration marks never sends OSC 133;B: type it anyway once it has had time to start.
        this.runTimer = window.setTimeout(() => this.runPending(), LAUNCH_FALLBACK_MS);
      }
    }
  }

  async restart(): Promise<void> {
    this.started = true;
    await this.open();
    // The previous output stays in scrollback; the new shell starts at the top, where ConPTY thinks it is.
    await this.resetForShell();
    if (this.disposed) return;
    await this.spawn();
  }

  /** Moves the host into a pane slot (visible) or back to the off-screen parking area. */
  attach(container: HTMLElement | null): void {
    const target = container ?? this.parking;
    if (this.host.parentElement !== target) target.appendChild(this.host);
    const visible = !!container;
    if (visible === this.visible) {
      if (visible) this.repaintSoon();
      return;
    }
    this.visible = visible;
    if (visible) {
      patchRuntime(this.id, { activity: false });
      this.repaintSoon();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * WebGL slot on or off (the registry decides, within the WebGL context budget). The renderer setting decides
   * whether a slot is used at all.
   */
  setGpu(slot: boolean): void {
    this.gpuSlot = slot;
    const want = slot && useApp.getState().settings.renderer === 'gpu';
    if (!this.opened || !this.term.element || this.disposed) return;
    if (want && !this.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // GPU reset or driver update: drop to the DOM renderer instead of a blank screen; main tells us when the
          // GPU is back (gpu:restored) and the registry turns WebGL on again.
          webgl.dispose();
          if (this.webgl === webgl) this.webgl = null;
          toast(t('term.webglLost'));
        });
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch {
        this.webgl = null;
      }
      this.repaintSoon();
    } else if (!want && this.webgl) {
      this.webgl.dispose();
      this.webgl = null;
      this.repaintSoon();
    }
  }

  hasGpu(): boolean {
    return this.webgl !== null;
  }

  hasGpuSlot(): boolean {
    return this.gpuSlot;
  }

  /** Refit, drop cached glyphs and repaint every row on the next frame. */
  repaintSoon(): void {
    requestAnimationFrame(() => {
      if (!this.opened || !this.visible) return;
      this.fitNow(false);
      this.term.clearTextureAtlas();
      this.term.refresh(0, this.term.rows - 1);
    });
  }

  focus(): void {
    requestAnimationFrame(() => this.term.focus());
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.observer.disconnect();
    clearTimeout(this.runTimer);
    clearTimeout(this.ackTimer);
    clearTimeout(this.resizeTimer);
    this.webgl?.dispose();
    this.term.dispose();
    this.host.remove();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // ───────────── Settings & theme ─────────────

  applySettings(s: Settings): void {
    const fontChanged =
      this.term.options.fontFamily !== fontFamily(s.fontFamily) || this.baseFontSize !== s.fontSize;
    this.baseFontSize = s.fontSize;
    const o = this.term.options;
    o.lineHeight = s.lineHeight;
    o.letterSpacing = s.letterSpacing;
    o.fontWeight = s.fontWeight as 400;
    o.fontWeightBold = s.fontWeightBold as 700;
    o.cursorStyle = s.cursor;
    o.cursorBlink = s.cursorBlink;
    o.scrollback = s.scrollback;
    o.wordSeparator = s.wordSeparators;
    this.applyTheme();
    this.setGpu(this.gpuSlot);
    const apply = () => {
      o.fontFamily = fontFamily(s.fontFamily);
      o.fontSize = this.fontSize();
      this.repaintSoon();
    };
    if (fontChanged) void loadFonts(s.fontSize, s.fontFamily).then(apply);
    else apply();
  }

  applyTheme(): void {
    const app = useApp.getState();
    const spec = findTerminal(this.id)?.terminal;
    const theme = terminalTheme(
      app.settings.colorScheme,
      app.dark,
      spec?.color ?? null,
      app.settings.tintWithColor,
    );
    this.term.options.theme = theme.xterm;
    this.term.options.minimumContrastRatio = Math.max(app.settings.minimumContrast, theme.minimumContrast);
    this.host.style.background = theme.xterm.background ?? '';
  }

  private fontSize(): number {
    return Math.max(6, Math.min(72, this.baseFontSize + this.zoom));
  }

  private setZoom(z: number): void {
    this.zoom = Math.max(-6, Math.min(24, z));
    this.term.options.fontSize = this.fontSize();
    this.repaintSoon();
  }

  // ───────────── Size ─────────────

  private scheduleFit(): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.fitNow(false), 50);
  }

  private fitNow(force: boolean): void {
    if (!this.opened || !this.term.element) return;
    // Parked terminals keep their pane size; only the first fit (before the shell starts) uses the parking size.
    if (!this.visible && !force) return;
    if (this.host.clientWidth < 20 || this.host.clientHeight < 10) return; // collapsed
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.term.cols < 2 || this.term.rows < 1) return;
    const key = `${this.term.cols}x${this.term.rows}`;
    if (force || key !== this.lastSize) {
      this.lastSize = key;
      ptyPort.post({ t: 'resize', id: this.id, cols: this.term.cols, rows: this.term.rows });
    }
  }

  // ───────────── Data ─────────────

  private onFrame(f: Extract<PtyFrame, { t: 'data' | 'exit' }>): void {
    if (f.t === 'data') {
      const n = f.d.length;
      this.term.write(f.d, () => {
        this.pendingAck += n;
        if (!this.ackTimer) this.ackTimer = window.setTimeout(() => this.flushAck(), ACK_INTERVAL_MS);
      });
      this.dirty = true;
      const rt = runtimeOf(this.id);
      if (!rt.ready) patchRuntime(this.id, { ready: true });
      if (!this.visible && !rt.activity) patchRuntime(this.id, { activity: true });
      return;
    }
    patchRuntime(this.id, { status: 'exited', exitCode: f.code });
    this.term.write(`\r\n\x1b[2m${t('term.exited', f.code)} ${t('term.restartHint')}\x1b[0m\r\n`);
  }

  private flushAck(): void {
    this.ackTimer = 0;
    if (this.pendingAck > 0) {
      ptyPort.post({ t: 'ack', id: this.id, n: this.pendingAck });
      this.pendingAck = 0;
    }
  }

  private input(d: string): void {
    const status = runtimeOf(this.id).status;
    if (status === 'exited' || status === 'failed') {
      if (d === '\r') void this.restart();
      return;
    }
    ptyPort.post({ t: 'input', id: this.id, d });
    // PowerShell marks no command start (OSC 133;C): Enter on the prompt starts it.
    if (!this.command && this.promptEnd && d.includes('\r')) this.startCommand();
    else if (this.command && d.includes('\x03')) this.command.interrupted = true;
  }

  /** Types the launcher's command into the shell, once, as if the user had typed it. */
  private runPending(): void {
    clearTimeout(this.runTimer);
    const cmd = this.pendingRun;
    this.pendingRun = null;
    if (!cmd || this.disposed || runtimeOf(this.id).status !== 'running') return;
    this.launched = true;
    this.input(cmd + '\r');
  }

  /** Types text as a paste (bracketed when the program asked for it). */
  pasteText(text: string): void {
    this.term.paste(text);
    this.term.focus();
  }

  // ───────────── Clipboard ─────────────

  async copy(clear: boolean): Promise<void> {
    if (!this.term.hasSelection()) return;
    await api.invoke('clipboard:write-text', this.term.getSelection());
    if (clear) this.term.clearSelection();
  }

  /** Ctrl+V: files → their quoted paths; an image → the path of its saved PNG; text → text (multi-line guard). */
  async paste(asPath = false): Promise<void> {
    const c = await api.invoke('clipboard:read-paste');
    if (c.kind === 'files') return this.pasteText(quotePaths(c.paths, this.kind, this.distro));
    if (c.kind === 'image') return this.pasteText(quotePaths([c.path], this.kind, this.distro));
    if (c.kind === 'empty') return toast(t('term.nothingToPaste'));
    let text = c.text.replace(/\r\n?/g, '\n');
    if (asPath)
      return this.pasteText(quotePaths([text.trim().replace(/^"(.*)"$/, '$1')], this.kind, this.distro));
    const lines = text.replace(/\n+$/, '').split('\n').length;
    if (useApp.getState().settings.warnMultilinePaste && lines > 1 && !this.term.modes.bracketedPasteMode) {
      const ok = await confirmDialog({
        title: t('term.pasteWarn.title', lines),
        body: t('term.pasteWarn.body'),
        ok: t('term.pasteWarn.ok'),
      });
      if (!ok) return this.term.focus();
    }
    if (!this.term.modes.bracketedPasteMode) text = text.replace(/\n$/, '');
    this.pasteText(text);
  }

  private onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length > 0) this.pasteText(quotePaths(paths, this.kind, this.distro));
  }

  // ───────────── Keyboard ─────────────

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const handled = this.handleKey(e);
    // The browser must not also act on a key Atelier took (Ctrl+Shift+V would paste natively).
    if (!handled) e.preventDefault();
    return handled;
  }

  /** Returns true when the key belongs to the shell. */
  private handleKey(e: KeyboardEvent): boolean {
    const { ctrlKey: ctrl, shiftKey: shift, altKey: alt } = e;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const app = appShortcut(e);
    if (app) {
      runShortcut(app);
      return false;
    }
    if (ctrl && shift && !alt && k === 'c') return (void this.copy(false), false);
    if (
      ctrl &&
      !shift &&
      !alt &&
      k === 'c' &&
      useApp.getState().settings.smartCtrlC &&
      this.term.hasSelection()
    ) {
      return (void this.copy(true), false);
    }
    if ((ctrl && !alt && k === 'v') || (shift && !ctrl && !alt && k === 'Insert'))
      return (void this.paste(), false);
    if (ctrl && !shift && !alt && k === 'Insert') return (void this.copy(false), false);
    if (ctrl && shift && !alt && k === 'f') return (this.openSearch(), false);
    if (ctrl && shift && !alt && k === 'a') return (this.term.selectAll(), false);
    if (ctrl && !shift && !alt && (k === '=' || k === '+')) return (this.setZoom(this.zoom + 1), false);
    if (ctrl && !shift && !alt && k === '-') return (this.setZoom(this.zoom - 1), false);
    if (ctrl && !shift && !alt && k === '0') return (this.setZoom(0), false);
    if (ctrl && shift && !alt && k === 'ArrowUp') return (this.jumpPrompt(-1), false);
    if (ctrl && shift && !alt && k === 'ArrowDown') return (this.jumpPrompt(1), false);
    if (shift && !ctrl && !alt && k === 'PageUp') return (this.term.scrollPages(-1), false);
    if (shift && !ctrl && !alt && k === 'PageDown') return (this.term.scrollPages(1), false);
    if (ctrl && shift && !alt && k === 'Home') return (this.term.scrollToTop(), false);
    if (ctrl && shift && !alt && k === 'End') return (this.term.scrollToBottom(), false);
    return true;
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setZoom(this.zoom + (e.deltaY < 0 ? 1 : -1));
  }

  // ───────────── Shell integration (OSC 133 marks, OSC 7 directory) ─────────────

  private registerShellIntegration(): void {
    this.term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';');
      if (kind === 'A') {
        const hadClaude = !!useRuntime.getState().claude[this.id]?.state;
        if (hadClaude) void api.invoke('claude:shell-prompt', this.id);
        // The shell is back after Claude (exit, crash, or `claude` not found): don't resume it on the next start.
        if (hadClaude || this.launched) {
          this.launched = false;
          endClaudeSession(this.id);
        }
        const marker = this.term.registerMarker(0);
        if (marker) {
          this.prompts.push({ marker, exit: null });
          if (this.prompts.length > 2000) this.prompts.shift()!.marker.dispose();
        }
      } else if (kind === 'B') {
        this.promptEnd?.marker.dispose();
        const marker = this.term.registerMarker(0);
        this.promptEnd = marker ? { marker, x: this.term.buffer.active.cursorX } : null;
        this.command = null;
        this.promptSeen = true;
        // The new shell is ready for input. Later, so the shell has handled this prompt before the keys arrive.
        if (this.pendingRun) window.setTimeout(() => this.runPending(), 0);
      } else if (kind === 'C') {
        if (!this.command) this.startCommand();
      } else if (kind === 'D') {
        const code = parseInt(arg ?? '', 10);
        this.commandEnded(Number.isNaN(code) ? 0 : code);
      }
      if (kind === 'D' && this.prompts.length > 0) {
        const last = this.prompts[this.prompts.length - 1]!;
        const code = parseInt(arg ?? '', 10);
        if (last.exit === null && !Number.isNaN(code)) {
          last.exit = code;
          if (code !== 0) {
            const danger =
              getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#F0605D';
            this.term.registerDecoration({
              marker: last.marker,
              overviewRulerOptions: { color: danger, position: 'full' },
            });
          }
        }
      }
      return true;
    });
    // Properties from Atelier's prompt (VS Code's format): the git branch shown in the sidebar.
    this.term.parser.registerOscHandler(633, (data) => {
      const m = /^P;GitBranch=(.*)$/s.exec(data);
      if (m) patchRuntime(this.id, { branch: m[1]!.slice(0, 200) || undefined });
      return true;
    });
    this.term.parser.registerOscHandler(7, (data) => {
      const osc = parseOsc7(data);
      const app = useApp.getState();
      if (osc && isLocalOscHost(osc.host, app.hostname)) {
        setLastCwd(this.id, shellPathToNative(osc.path, this.kind, app.platform, this.distro));
      }
      return true;
    });
  }

  private jumpPrompt(dir: number): void {
    const live = this.prompts.filter((p) => !p.marker.isDisposed && p.marker.line >= 0);
    if (live.length === 0) return;
    const top = this.term.buffer.active.viewportY;
    const target =
      dir < 0 ? [...live].reverse().find((p) => p.marker.line < top) : live.find((p) => p.marker.line > top);
    if (target) this.term.scrollToLine(target.marker.line);
    else if (dir > 0) this.term.scrollToBottom();
  }

  private startCommand(): void {
    this.command = {
      start: Date.now(),
      interactive: this.term.buffer.active.type === 'alternate',
      interrupted: false,
    };
  }

  /**
   * A command ended (OSC 133;D). One that ran long enough raises a notification, unless it was interactive (it took
   * over the screen, or it was a Claude session: those have their own notifications and the user ended them).
   */
  private commandEnded(code: number): void {
    const cmd = this.command;
    this.command = null;
    if (!cmd) return;
    const elapsed = Date.now() - cmd.start;
    const s = useApp.getState().settings;
    if (!s.notifications || !s.notifyLongCommand || elapsed < s.notifyLongCommandSeconds * 1000) return;
    if (cmd.interactive || cmd.interrupted || claudeSince(this.id, cmd.start)) return;
    const duration = formatDuration(elapsed);
    const title = code !== 0 ? t('notify.commandFailed', code, duration) : t('notify.commandOk', duration);
    notify(this.id, 'command', title, this.commandText());
  }

  /** What the user typed after the last prompt (wrapped rows joined), at most 80 characters. */
  private commandText(): string | undefined {
    const p = this.promptEnd;
    if (!p || p.marker.isDisposed || p.marker.line < 0) return undefined;
    const b = this.term.buffer.normal;
    let text = b.getLine(p.marker.line)?.translateToString(true, p.x) ?? '';
    for (let i = p.marker.line + 1; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line?.isWrapped) break;
      text += line.translateToString(true);
    }
    const chars = Array.from(text.trim());
    if (chars.length === 0) return undefined;
    return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : chars.join('');
  }

  private bell(): void {
    const name = findTerminal(this.id)?.terminal.name;
    if (name) notify(this.id, 'bell', t('notify.bell', name));
    const mode = useApp.getState().settings.bell;
    if (mode === 'sound') void api.invoke('shell:beep');
    if (mode !== 'visual') return;
    this.host.classList.add('bell');
    window.setTimeout(() => this.host.classList.remove('bell'), 150);
  }

  // ───────────── Search ─────────────

  private searchOptions(incremental = false): ISearchOptions {
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#7480FF';
    const warn = css.getPropertyValue('--warn').trim() || '#E0AE45';
    const s = this.searchState;
    return {
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      regex: s.regex,
      incremental,
      decorations: {
        matchBackground: accent + '55',
        matchOverviewRuler: accent,
        activeMatchBackground: warn + 'AA',
        activeMatchColorOverviewRuler: warn,
      },
    };
  }

  openSearch(): void {
    const sel = this.term.hasSelection() ? this.term.getSelection() : '';
    this.searchState = {
      ...this.searchState,
      open: true,
      query: sel && !sel.includes('\n') ? sel : this.searchState.query,
    };
    this.notify();
  }

  closeSearch(): void {
    this.searchState = { ...this.searchState, open: false, resultCount: 0, resultIndex: -1 };
    this.search.clearDecorations();
    this.notify();
    this.term.focus();
  }

  setSearch(patch: Partial<SearchState>): void {
    this.searchState = { ...this.searchState, ...patch };
    this.notify();
    if (!this.searchState.query) {
      this.search.clearDecorations();
      this.searchState = { ...this.searchState, resultCount: 0, resultIndex: -1 };
      return;
    }
    try {
      this.search.findNext(this.searchState.query, this.searchOptions(true));
    } catch {
      /* invalid regex while typing */
    }
  }

  findNext(back = false): void {
    const q = this.searchState.query;
    if (!q) return;
    try {
      if (back) this.search.findPrevious(q, this.searchOptions());
      else this.search.findNext(q, this.searchOptions());
    } catch {
      /* invalid regex */
    }
  }

  // ───────────── Text out ─────────────

  /** The buffer as plain text (wrapped lines joined), the last `maxLines` lines. */
  text(maxLines = Infinity): string {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.slice(-maxLines).join('\n');
  }

  /** Text between the last two prompts (needs the shell integration). */
  lastCommandOutput(): string {
    const live = this.prompts.filter((p) => !p.marker.isDisposed);
    if (live.length < 2) return '';
    const from = live[live.length - 2]!.marker.line + 1;
    const to = live[live.length - 1]!.marker.line;
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = from; i < to; i++) {
      const line = b.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  /** Screen and recent scrollback with colors, for the restore snapshot. */
  snapshot(): string {
    return this.serializer.serialize({ scrollback: 1000, excludeAltBuffer: true, excludeModes: true });
  }

  /**
   * Clear history: drops the scrollback only (ED 3). The screen and the cursor stay put: ConPTY keeps its own copy of
   * the screen and places text with absolute positions, and its clear() (1.23) doesn't move it, so moving the prompt
   * line to the top here (xterm's clear()) would put what is typed on another line.
   */
  clear(): void {
    this.term.write('\x1b[3J', () => {
      // Markers on the dropped lines were disposed with them.
      for (let i = this.prompts.length - 1; i >= 0; i--) {
        if (this.prompts[i]!.marker.isDisposed) this.prompts.splice(i, 1);
      }
    });
  }

  // ───────────── Context menu ─────────────

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (useApp.getState().settings.rightClick === 'copypaste') {
      if (this.term.hasSelection()) void this.copy(true);
      else void this.paste();
      return;
    }
    const has = this.term.hasSelection();
    openMenu(e.clientX, e.clientY, [
      { label: t('term.copy'), shortcut: 'Ctrl+Shift+C', disabled: !has, run: () => void this.copy(false) },
      { label: t('term.paste'), shortcut: 'Ctrl+V', run: () => void this.paste() },
      { label: t('term.pastePath'), run: () => void this.paste(true) },
      { label: t('term.selectAll'), shortcut: 'Ctrl+Shift+A', run: () => this.term.selectAll() },
      'separator',
      { label: t('term.find'), shortcut: 'Ctrl+Shift+F', run: () => this.openSearch() },
      {
        label: t('term.copyLastOutput'),
        run: () => {
          const out = this.lastCommandOutput();
          if (!out) return toast(t('term.noLastOutput'));
          void api.invoke('clipboard:write-text', out).then(() => toast(t('term.copied'), 'success'));
        },
      },
      {
        label: t('term.saveOutput'),
        run: () =>
          void api
            .invoke('dialog:save-text', {
              title: t('term.saveOutput'),
              defaultName: `${findTerminal(this.id)?.terminal.name ?? 'terminal'}.txt`,
              text: this.text() + '\n',
            })
            .then((ok) => ok && toast(t('term.saved'), 'success')),
      },
      { label: t('term.clear'), run: () => this.clear() },
    ]);
  }
}
