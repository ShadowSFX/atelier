import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import {
  applyOp,
  DESCRIBE_ATTEMPTS,
  EMPTY_LIBRARY,
  findByPath,
  newEntry,
  parseLibrary,
  type Library,
  type LibraryEntry,
  type LibraryOp,
} from '@shared/library';
import {
  DESCRIBE_ARGS,
  DESCRIBE_MODEL,
  DESCRIBE_TIMEOUT_MS,
  describePrompt,
  parseDescription,
  parseEnvelope,
} from '@shared/describe';
import { pathIdentity, type Workspace } from '@shared/workspace';
import type { ClaudeRunner } from '../claude/background';
import { log } from '../log';
import { JsonStore, readJson } from '../store/JsonStore';
import { analyzeFolder } from './analyze';

/** Folders analyzed at once (a bulk import of 60 Desktop folders). */
const ANALYZE_CONCURRENCY = 3;
/** Local facts older than this are read again when the library is shown. */
const STALE_MS = 10 * 60_000;
/** A failed description is tried again after this long (next start or later). */
const RETRY_DELAY_MS = 60_000;

export interface LibraryDeps {
  file: string;
  /** Main's copy of the workspace (open projects). */
  workspace: () => Workspace;
  emit: (lib: Library) => void;
  /** The claude executable, or null when it isn't installed (asked again for every job). */
  claudeExe: () => string | null;
  runner: (exe: string) => ClaudeRunner;
  lang: () => 'es' | 'en';
  now?: () => number;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project library (library.json): owned here, mirrored by the renderer, which changes it with LibraryOps.
 * Also runs the local analysis of each folder and the queue of Claude descriptions (one at a time, in the
 * background, persisted in each entry's job so it continues after a restart).
 */
export class LibraryService {
  private readonly store: JsonStore<Library>;
  private readonly now: () => number;
  private emitTimer: NodeJS.Timeout | null = null;
  private readonly analyzing = new Set<string>();
  private analyzeQueue: string[] = [];
  private describing: { id: string; abort: AbortController } | null = null;
  private describeTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Entries a move is working on: no analysis or description runs in them meanwhile. */
  private readonly locked = new Set<string>();

  constructor(private readonly deps: LibraryDeps) {
    this.now = deps.now ?? Date.now;
    const first = !existsSync(deps.file) && readJson(deps.file) === undefined;
    this.store = new JsonStore(deps.file, parseLibrary);
    if (first) this.migrateFromWorkspace();
    this.reconcile(deps.workspace());
    // Entries never analyzed (migrated ones, or an interrupted start) are read now.
    for (const e of this.get().entries) if (!e.local) this.queueAnalysis(e.id);
  }

  get(): Library {
    return this.store.get();
  }

  private set(lib: Library, flush = false): void {
    this.store.set(lib);
    if (flush) this.store.flush();
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.deps.emit(this.store.get());
    }, 30);
  }

  flushPending(): void {
    this.store.flushPending();
  }

  private patch(id: string, fn: (e: LibraryEntry) => LibraryEntry, flush = false): void {
    const lib = this.get();
    if (!lib.entries.some((e) => e.id === id)) return;
    this.set({ ...lib, entries: lib.entries.map((e) => (e.id === id ? fn(e) : e)) }, flush);
  }

  entry(id: string): LibraryEntry | null {
    return this.get().entries.find((e) => e.id === id) ?? null;
  }

  // ───────────── Workspace ↔ library ─────────────

  /** First start with a library: every open project becomes an entry (same id), described in the background. */
  private migrateFromWorkspace(): void {
    let lib = EMPTY_LIBRARY;
    for (const p of this.deps.workspace().projects) {
      if (findByPath(lib, p.path)) continue;
      const e = { ...newEntry(p.id, p.path, this.now(), p.name), color: p.color };
      lib = { ...lib, entries: [...lib.entries, { ...e, job: { state: 'queued' as const, attempts: 0 } }] };
    }
    this.set(lib, true);
  }

  /**
   * Every open project has its entry (same id); an entry whose project is open has no remembered setup (after a
   * crash both could exist: the open one wins).
   */
  reconcile(ws: Workspace): void {
    let lib = this.get();
    let changed = false;
    const added: string[] = [];
    for (const p of ws.projects) {
      const byId = lib.entries.find((e) => e.id === p.id);
      if (byId) {
        if (byId.remembered) {
          lib = { ...lib, entries: lib.entries.map((e) => (e === byId ? { ...e, remembered: null } : e)) };
          changed = true;
        }
        continue;
      }
      const byPath = findByPath(lib, p.path);
      if (byPath) continue; // the renderer opened it under the entry's id; nothing to add
      const e = { ...newEntry(p.id, p.path, this.now(), p.name), color: p.color };
      lib = { ...lib, entries: [...lib.entries, { ...e, job: { state: 'queued' as const, attempts: 0 } }] };
      changed = true;
      added.push(p.id);
    }
    if (changed) this.set(lib);
    for (const id of added) this.queueAnalysis(id);
  }

  /** Terminal ids of closed projects' remembered setups (their snapshots are kept). */
  rememberedTerminalIds(): string[] {
    return this.get().entries.flatMap((e) => e.remembered?.terminals.map((t) => t.id) ?? []);
  }

  // ───────────── Renderer operations ─────────────

  apply(op: LibraryOp): Library {
    const before = this.get();
    // A project being moved stays in the library until the move is over.
    if (op.op === 'remove') op = { ...op, ids: op.ids.filter((id) => !this.locked.has(id)) };
    const after = applyOp(before, op);
    if (after !== before) this.set(after, op.op === 'remember' || op.op === 'remove');
    return after;
  }

  /**
   * Adds folders (existing entries are returned as they are). An open project with that folder lends its id, so
   * the tab and the entry stay one project. New entries are analyzed now and queued for a description.
   */
  add(paths: string[], collectionId: string | null = null): LibraryEntry[] {
    let lib = this.get();
    const out: LibraryEntry[] = [];
    const open = this.deps.workspace().projects;
    for (const path of paths) {
      if (!isDir(path)) continue;
      const existing = findByPath(lib, path);
      if (existing) {
        out.push(existing);
        continue;
      }
      const project = open.find((p) => pathIdentity(p.path) === pathIdentity(path));
      const id = project?.id ?? 'p' + randomUUID().replace(/-/g, '').slice(0, 16);
      const e: LibraryEntry = {
        ...newEntry(id, path, this.now(), project?.name),
        color: project?.color ?? null,
        collectionId:
          collectionId && lib.collections.some((c) => c.id === collectionId) ? collectionId : null,
        job: { state: 'queued', attempts: 0 },
      };
      lib = { ...lib, entries: [...lib.entries, e] };
      out.push(e);
    }
    this.set(lib, true);
    // Once they are in the library (the analysis looks them up there).
    for (const e of out) if (!e.local) this.queueAnalysis(e.id);
    return out;
  }

  /** A missing folder was found somewhere else (the user picked it). */
  locate(id: string, path: string): LibraryEntry | null {
    if (!isDir(path)) return null;
    const other = findByPath(this.get(), path);
    if (other && other.id !== id) return null;
    this.patch(id, (e) => ({ ...e, path, missing: false }), true);
    this.queueAnalysis(id, true);
    return this.entry(id);
  }

  /** A move finished: entries inside the old folder follow (done by the move with rebaseLibrary). */
  replace(lib: Library): void {
    this.set(lib, true);
  }

  // ───────────── Local analysis ─────────────

  /** Re-reads stale or missing facts (the library view opened) and notices folders that went missing. */
  refresh(ids?: string[], force = false): void {
    const lib = this.get();
    const want = ids ? lib.entries.filter((e) => ids.includes(e.id)) : lib.entries;
    let changed = false;
    const entries = lib.entries.map((e) => {
      if (!want.includes(e)) return e;
      const missing = !isDir(e.path);
      if (missing !== e.missing) changed = true;
      return missing !== e.missing ? { ...e, missing } : e;
    });
    if (changed) this.set({ ...lib, entries });
    for (const e of entries)
      if (
        want.some((w) => w.id === e.id) &&
        !e.missing &&
        (force || !e.local || this.now() - e.local.analyzedAt > STALE_MS)
      )
        this.queueAnalysis(e.id, force);
  }

  private queueAnalysis(id: string, force = false): void {
    if (this.analyzing.has(id) || (!force && this.analyzeQueue.includes(id))) return;
    if (!this.analyzeQueue.includes(id)) this.analyzeQueue.push(id);
    this.pumpAnalysis();
  }

  private pumpAnalysis(): void {
    while (!this.stopped && this.analyzing.size < ANALYZE_CONCURRENCY && this.analyzeQueue.length > 0) {
      const id = this.analyzeQueue.shift()!;
      const e = this.entry(id);
      if (!e || this.locked.has(id)) continue;
      this.analyzing.add(id);
      const path = e.path;
      void analyzeFolder(path, this.now)
        .then((local) => {
          // Moved or removed meanwhile: these facts are about a folder the entry no longer points at.
          if (this.entry(id)?.path !== path) return;
          this.patch(id, (x) => ({ ...x, local, missing: false }));
        })
        .catch((err: unknown) => log.warn('project analysis failed', path, err))
        .finally(() => {
          this.analyzing.delete(id);
          this.pumpAnalysis();
          this.scheduleDescribe(0);
        });
    }
  }

  // ───────────── Claude descriptions ─────────────

  /** Asks Claude (again) for these entries' descriptions. */
  describe(ids: string[]): void {
    const set = new Set(ids);
    const lib = this.get();
    this.set({
      ...lib,
      entries: lib.entries.map((e) => (set.has(e.id) ? { ...e, job: { state: 'queued', attempts: 0 } } : e)),
    });
    this.scheduleDescribe(0);
  }

  /** Starts the queue (at startup, once the window is up). */
  start(): void {
    this.scheduleDescribe(2_000);
  }

  private scheduleDescribe(delay: number): void {
    if (this.stopped || this.describing || this.describeTimer) return;
    this.describeTimer = setTimeout(() => {
      this.describeTimer = null;
      void this.describeNext();
    }, delay);
  }

  private nextJob(): LibraryEntry | null {
    return (
      this.get().entries.find(
        (e) =>
          e.job.state === 'queued' &&
          !e.missing &&
          !this.locked.has(e.id) &&
          // The local facts go into the prompt: wait for them (they take a moment).
          (e.local !== null || !this.analyzing.has(e.id)),
      ) ?? null
    );
  }

  private async describeNext(): Promise<void> {
    if (this.stopped || this.describing) return;
    const e = this.nextJob();
    if (!e) {
      // Failed jobs are retried later, a few times.
      const retry = this.get().entries.some(
        (x) => x.job.state === 'error' && x.job.attempts < DESCRIBE_ATTEMPTS,
      );
      if (retry) {
        this.describeTimer = setTimeout(() => {
          this.describeTimer = null;
          this.requeueErrors();
        }, RETRY_DELAY_MS);
      }
      return;
    }
    const exe = this.deps.claudeExe();
    if (!exe) {
      // Without Claude Code every queued job waits as "unavailable" (asked again with "Describe again").
      const lib = this.get();
      this.set({
        ...lib,
        entries: lib.entries.map((x) =>
          x.job.state === 'queued' ? { ...x, job: { ...x.job, state: 'unavailable' as const } } : x,
        ),
      });
      return;
    }
    const abort = new AbortController();
    this.describing = { id: e.id, abort };
    const path = e.path;
    this.patch(e.id, (x) => ({ ...x, job: { state: 'running', attempts: x.job.attempts + 1 } }));
    try {
      const run = this.deps.runner(exe);
      const stdout = await run([...DESCRIBE_ARGS], DESCRIBE_TIMEOUT_MS, {
        input: describePrompt(this.deps.lang(), e.local),
        cwd: path,
        signal: abort.signal,
      });
      const env = parseEnvelope(stdout);
      if (!env.ok) throw Object.assign(new Error(env.message), { failure: env.failure });
      const d = parseDescription(env.result);
      if (!d) throw new Error('the answer was not a description');
      if (this.entry(e.id)?.path !== path) return; // moved meanwhile: describe it again where it is now
      this.patch(e.id, (x) => ({
        ...x,
        claude: { ...d, model: DESCRIBE_MODEL, at: this.now() },
        job: { state: 'done', attempts: x.job.attempts },
      }));
    } catch (err) {
      const cancelled = abort.signal.aborted;
      const failure = (err as { failure?: string }).failure;
      const out = String((err as { stdout?: string }).stdout ?? '');
      const auth = failure === 'auth' || (!failure && /not logged in|\/login|invalid api key/i.test(out));
      if (!cancelled) log.warn('project description failed', path, err);
      this.patch(e.id, (x) => ({
        ...x,
        job: cancelled
          ? { state: 'queued', attempts: Math.max(0, x.job.attempts - 1) }
          : auth
            ? { state: 'auth', attempts: x.job.attempts, error: 'auth' }
            : {
                state: 'error',
                attempts: x.job.attempts,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
              },
      }));
      if (auth) this.pauseQueueForAuth();
    } finally {
      this.describing = null;
      this.scheduleDescribe(500);
    }
  }

  /** Not signed in: the other queued jobs would fail the same way. */
  private pauseQueueForAuth(): void {
    const lib = this.get();
    this.set({
      ...lib,
      entries: lib.entries.map((x) =>
        x.job.state === 'queued' ? { ...x, job: { ...x.job, state: 'auth' as const } } : x,
      ),
    });
  }

  private requeueErrors(): void {
    const lib = this.get();
    this.set({
      ...lib,
      entries: lib.entries.map((x) =>
        x.job.state === 'error' && x.job.attempts < DESCRIBE_ATTEMPTS
          ? { ...x, job: { ...x.job, state: 'queued' as const } }
          : x,
      ),
    });
    this.scheduleDescribe(0);
  }

  // ───────────── Moves ─────────────

  /** A move is working on these entries: analysis and descriptions stop (a running one is cancelled). */
  lock(ids: string[]): void {
    for (const id of ids) this.locked.add(id);
    if (this.describing && ids.includes(this.describing.id)) this.describing.abort.abort();
  }

  unlock(ids: string[]): void {
    for (const id of ids) {
      this.locked.delete(id);
      this.queueAnalysis(id, true);
    }
    this.scheduleDescribe(0);
  }

  isLocked(id: string): boolean {
    return this.locked.has(id);
  }

  /** Quitting: the running description is killed (it is queued again on the next start). */
  stop(): void {
    this.stopped = true;
    if (this.describeTimer) clearTimeout(this.describeTimer);
    this.describing?.abort.abort();
    this.store.flushPending();
  }
}
