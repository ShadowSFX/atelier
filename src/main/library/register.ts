import { readdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import type { DiskInfo, Events, ScanItem } from '@shared/ipc';
import { parseBackgroundSessions } from '@shared/launchers';
import { findByPath, parseOp, type Library } from '@shared/library';
import type { Workspace } from '@shared/workspace';
import type { ClaudeState } from '@shared/ipc';
import { claudeRunner } from '../claude/background';
import { claudeConfigDir } from '../claude/sessions';
import { handle } from '../ipc';
import { log } from '../log';
import { baseEnv } from '../pty/PtyManager';
import { analyzeFolder } from './analyze';
import { LibraryService } from './LibraryService';
import { Mover } from './move';

/** Folders a scan lists at most, and how long each one's file walk may take. */
const SCAN_MAX = 300;
const SCAN_WALK_MS = 400;
const SCAN_CONCURRENCY = 6;
/** Not projects: Windows' own folders inside a drive or a profile. */
const SCAN_SKIP = /^(\$recycle\.bin|system volume information|node_modules|\..*|desktop\.ini)$/i;

export interface LibraryWiring {
  userData: string;
  workspace: { get(): Workspace; set(ws: Workspace): void };
  send: <K extends keyof Events>(channel: K, ...args: Parameters<Events[K]>) => void;
  claudeExe: () => string | null;
  lang: () => 'es' | 'en';
  protectedPaths: () => string[];
  running: (id: string) => boolean;
  busy: (ids: string[]) => string[];
  foreground: (ids: string[]) => Map<string, string | null>;
  claudeState: (id: string) => ClaudeState | null;
  kill: (id: string) => void;
  settled: () => Promise<void>;
  git: () => string | null;
}

/** Claude Code with Atelier's own variables dropped (baseEnv) and its self-update off for these short runs. */
function runnerFor(exe: string) {
  return claudeRunner(exe, { ...baseEnv(), DISABLE_AUTOUPDATER: '1' });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** The project library and moves: services and their IPC. Started once main's stores exist. */
export async function startLibrary(w: LibraryWiring): Promise<{
  library: LibraryService;
  mover: Mover;
}> {
  // A throwaway profile (end-to-end tests) never spends the user's Claude quota on descriptions, unless the run
  // asks for real Claude sessions (ATELIER_E2E_CLAUDE).
  const describeOff = !!process.env.ATELIER_USER_DATA && !process.env.ATELIER_E2E_CLAUDE;
  const library = new LibraryService({
    file: join(w.userData, 'library.json'),
    workspace: w.workspace.get,
    emit: (lib: Library) => w.send('library:changed', lib),
    claudeExe: describeOff ? () => null : w.claudeExe,
    runner: runnerFor,
    lang: w.lang,
  });
  const configDir = claudeConfigDir();
  const mover = new Mover({
    library,
    workspace: w.workspace,
    journalFile: join(w.userData, 'move-journal.json'),
    claudeConfigDir: configDir,
    claudeJson: process.env.CLAUDE_CONFIG_DIR
      ? join(configDir, '.claude.json')
      : join(homedir(), '.claude.json'),
    protectedPaths: w.protectedPaths,
    running: w.running,
    busy: w.busy,
    foreground: w.foreground,
    claudeState: w.claudeState,
    kill: w.kill,
    settled: w.settled,
    stopBackground: async (sessionIds) => {
      const exe = w.claudeExe();
      if (!exe) return;
      const run = runnerFor(exe);
      const wanted = new Set(sessionIds);
      const live = parseBackgroundSessions(await run(['agents', '--json'], 5_000)).filter((s) =>
        wanted.has(s.sessionId),
      );
      for (const s of live)
        await run(['stop', s.id], 15_000).catch((err: unknown) => log.warn('claude stop', s.id, err));
    },
    git: w.git,
    progress: (p) => w.send('move:progress', p),
    suspend: (id, ids) => w.send('move:suspend', id, ids),
    committed: (id, from, to, ids) => w.send('move:committed', id, from, to, ids),
    aborted: (id, ids) => w.send('move:aborted', id, ids),
  });
  // Before the window loads: an interrupted move is finished or undone, so the renderer reads the right paths.
  await mover.recover().catch((err: unknown) => log.error('move recovery', err));

  handle('library:load', () => library.get());
  handle('library:update', (raw) => {
    const op = parseOp(raw);
    if (!op) throw new Error('invalid library operation');
    return library.apply(op);
  });
  handle('library:add', (paths, collectionId) =>
    library.add(
      (Array.isArray(paths) ? paths : [])
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, 500),
      typeof collectionId === 'string' ? collectionId : null,
    ),
  );
  handle('library:refresh', (ids, force) =>
    library.refresh(Array.isArray(ids) ? ids : undefined, force === true),
  );
  handle('library:describe', (ids) => library.describe(Array.isArray(ids) ? ids : []));
  handle('library:locate', (id, path) => (typeof path === 'string' ? library.locate(id, path) : null));
  handle('library:scan', async (dir): Promise<ScanItem[]> => {
    if (typeof dir !== 'string' || !dir) return [];
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !SCAN_SKIP.test(d.name))
        .map((d) => d.name)
        .slice(0, SCAN_MAX);
    } catch {
      return [];
    }
    const lib = library.get();
    return mapLimit(names, SCAN_CONCURRENCY, async (name) => {
      const path = join(dir, name);
      return {
        path,
        name,
        facts: await analyzeFolder(path, Date.now, SCAN_WALK_MS),
        entryId: findByPath(lib, path)?.id ?? null,
      };
    });
  });
  handle('library:disk', async (paths): Promise<DiskInfo[]> => {
    const out: DiskInfo[] = [];
    for (const path of Array.isArray(paths) ? paths.slice(0, 50) : []) {
      if (typeof path !== 'string' || !path) continue;
      // A library folder that doesn't exist yet (a move creates it) reports its drive.
      for (const probe of [path, parse(path).root]) {
        try {
          const s = await statfs(probe);
          out.push({ path, free: s.bavail * s.bsize, total: s.blocks * s.bsize });
          break;
        } catch {
          /* not there yet, or an unplugged drive: try the drive, else no figure */
        }
      }
    }
    return out;
  });
  handle('move:plan', (entryId, destination) => mover.plan(entryId, destination));
  handle('move:start', (planId, wait) => mover.start(planId, wait === true));
  handle('move:cancel', (id) => mover.cancel(id));
  handle('move:suspended', (id) => mover.ack(id, 'suspended'));
  handle('move:applied', (id) => mover.ack(id, 'applied'));

  return { library, mover };
}
