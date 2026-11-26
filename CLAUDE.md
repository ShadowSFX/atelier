# Atelier — project-based terminal workspace

Electron + TypeScript + React + xterm.js 6 + node-pty. Projects (directories) are tabs in the title bar; each
project's terminals are listed in the left sidebar and shown in up to 3 columns. Claude Code sessions started in an
Atelier terminal talk only to the sessions of their own project (the "hub").

## Commands
- Dev: `npm run dev` (electron-vite, renderer HMR).
- Checks: `npm run typecheck`, `npm run lint`, `npm test` (Vitest, `tests/unit`).
- Build: `npm run build` (allowed for Claude in this repo). E2E: `npm run build && npm run e2e` (Playwright drives the
  built app with a throwaway profile via `ATELIER_USER_DATA`; `window.__atelier` exposes terminal text because WebGL
  draws on a canvas). `ATELIER_E2E_CLAUDE=1 npm run e2e` also runs two real Claude Code sessions through the hub
  (uses the API). Note: the app asks before closing terminals that run programs; tests destroy the window instead.
- Packages: `npm run dist` / `dist:win` / `dist:linux` — the owner's call, not Claude's. Release: push tag `vX.Y.Z`
  (`.github/workflows/release.yml` publishes `Atelier.exe` + `Atelier.exe.sha256` + AppImage + deb + latest-linux.yml).
- Windows ships as ONE portable `Atelier.exe` (no installer). Its stub unpacks the app to %TEMP% on every launch
  (silently) and sets `PORTABLE_EXECUTABLE_DIR/FILE`. Data lives in `Atelier.data\` next to the exe
  (`main/dataDir.ts`, imported first; AppData only when that folder isn't writable; `ATELIER_USER_DATA` wins).
  Self-update: `main/portableUpdater.ts` (GitHub → `.new` verified by SHA-256 → renamed in on restart/quit).
  0.1.0 was an NSIS install: releases still carry `Atelier-Setup-x.exe` + `latest.yml` for it; the installed copy
  swaps its own Atelier.exe for the portable one and the portable exe removes the setup's files and registry keys.

## Layout
- `src/shared` — pure logic, tested: IPC contract (`ipc.ts`, the only one), workspace model + ≤3-column layout
  (`workspace.ts`), settings (zod, tolerant), schemes, colors, path conversion/quoting/OSC 7 (`shell.ts`), hub
  protocol, i18n (`i18n.ts`: add es and en in one entry; a test checks both and their placeholders).
- `src/main` — services composed by hand in `index.ts`: `pty/PtyManager` (batching + flow control), `pty/profiles`,
  `shell/integration` + `shell/scripts/*` (powerline prompt + OSC 133/7/633 + `claude` wrapper per shell),
  `hub/` (HubServer + Delivery), `claude/integration` (per-session `--settings`/`--mcp-config` files), `stats/`,
  `store/` (atomic JSON + snapshots), `clipboard.ts`, `updater.ts`, `window.ts`, `library/` (project library:
  `LibraryService` owns `library.json`, local analysis + Claude descriptions via `claude -p`; `move.ts` moves folders).
- `src/agent` — run by Claude Code with `ELECTRON_RUN_AS_NODE=1` (Atelier's exe acts as node): `mcp.ts` (atelier_*
  tools), `hook.ts` (session state).
- `src/preload` — typed `window.atelier` API; the PTY MessagePort is handed to the page with window.postMessage.
- `src/renderer` — Zustand stores (`state/app`, `state/workspace`, `state/runtime`); components never call IPC
  directly, store actions do. `terminal/TerminalController` (port of RDMan's bridge.js, one per terminal) and
  `terminal/registry` (lifecycle, WebGL budget, snapshots).

## Rules that matter
- **Terminals are opened once and never re-mounted.** Their host element moves between a pane body and the
  off-screen parking area (`registry.attachTerminal/releaseTerminal`); showing one refits, clears the glyph atlas and
  repaints (`repaintSoon`). This is what prevents stale text. WebGL is kept only for visible + 3 recent terminals.
- Parked terminals don't resize their PTY (`fitNow` ignores non-forced fits while hidden).
- PTY output → renderer only through the MessagePort; xterm's write callback acks; main pauses the PTY above
  `FLOW_HIGH_WATER`. Constants live in `shared/constants.ts`.
- Hub scope comes from the token (`HubServer.issueToken`), never from the client. `Delivery` types a message into an
  idle session as a bracketed paste (control characters stripped) + Enter; otherwise queues it. Never into a
  permission prompt. A terminal's Claude state is cleared when its shell (re)starts or its shell prompt (OSC 133;A)
  comes back. Shell env drops a parent Claude Code session's variables (`STRIP_ENV` in PtyManager).
- Git Bash reports `pwd -W` in OSC 7 (Windows paths); WSL paths map to `\\wsl.localhost\<distro>\…`.
- Shell scripts: `atelier.ps1` must stay ASCII (PowerShell 5.1 reads BOM-less files as ANSI; a test checks it);
  bash/zsh are written with LF. Every script emits OSC 133 A/B/D, OSC 7 (percent-encoded) and `633;P;GitBranch`.
- Native modules must not need a compiler: node-pty uses its N-API prebuilds on Windows (`npmRebuild: false`),
  Win32 calls (process tree, CF_HDROP clipboard) go through koffi.
- npm 11 gates install scripts: new native deps must be added to `allowScripts` in package.json.
- Electron 45's `clipboard` is async (web-style `read()/readText()`).
- Colors only through CSS variables in `styles/tokens.css` (RDMan's tokens); UI text only through `t()/useT()`.
- Project library: main owns `library.json` (renderer sends `LibraryOp`s); an open tab is a workspace Project with its
  entry's id; a closed tab's terminals live in `entry.remembered` (their snapshots are kept). Moves are driven by main
  (`library/move.ts`, journaled in `move-journal.json`): stop the terminals inside, rename (or copy + verify across
  drives), then Claude data, git worktrees, rebase and restart. Descriptions are off in throwaway profiles
  (`ATELIER_USER_DATA`) unless `ATELIER_E2E_CLAUDE`.
- Commit messages: no co-author trailer.
