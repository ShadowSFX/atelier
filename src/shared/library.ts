import { z } from 'zod';
import { normalizeColor } from './colors';
import { isInsidePath } from './launchers';
import {
  baseName,
  parseLayout,
  parseTerminals,
  pathIdentity,
  type ProjectLayout,
  type TerminalSpec,
} from './workspace';

/**
 * The project library: every project folder the user keeps in Atelier, open (a tab) or not. Main owns it
 * (library.json); the renderer mirrors it and changes it only through `LibraryOp`s. An open project is a workspace
 * Project with the same id as its entry.
 */

export const PROJECT_KINDS = [
  'app',
  'web',
  'api',
  'library',
  'game',
  'tool',
  'service',
  'docs',
  'data',
  'scripts',
  'other',
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export type EntryStatus = 'active' | 'paused' | 'archived';

/** Share of the code files of one language (the card's language bar). */
export interface LanguageShare {
  name: string;
  files: number;
}

export interface GitFacts {
  branch: string | null;
  /** The folder is a linked worktree (its .git is a file). */
  worktree: boolean;
  lastCommitAt: number | null;
}

/** What Atelier reads from the folder itself, in a fraction of a second. */
export interface LocalFacts {
  stack: string[];
  languages: LanguageShare[];
  kind: ProjectKind | null;
  /** README's first paragraph or a manifest's description. */
  summary: string | null;
  git: GitFacts | null;
  /** Newest modification time among the folder's top-level entries. */
  modifiedAt: number | null;
  /** Manifests or source files were found (false: documents, installers, shortcuts…). */
  isCode: boolean;
  analyzedAt: number;
}

/** Claude's description of the project (claude -p). */
export interface ClaudeDescription {
  text: string;
  stack: string[];
  kind: ProjectKind;
  model: string;
  at: number;
}

/**
 * none: never asked; queued/running: waiting for or being described; done; error: failed (retried up to
 * DESCRIBE_ATTEMPTS); unavailable: Claude Code isn't installed; auth: Claude Code isn't signed in.
 */
export type DescribeState = 'none' | 'queued' | 'running' | 'done' | 'error' | 'unavailable' | 'auth';

export interface DescribeJob {
  state: DescribeState;
  attempts: number;
  error?: string;
}

/** A closed tab's terminals, brought back when the project is opened again (same ids: snapshots and sessions). */
export interface RememberedSetup {
  terminals: TerminalSpec[];
  layout: ProjectLayout;
}

export interface LibraryEntry {
  id: string;
  path: string;
  name: string;
  color: string | null;
  /** null: Inbox (not sorted yet). */
  collectionId: string | null;
  tags: string[];
  favorite: boolean;
  status: EntryStatus;
  addedAt: number;
  lastOpenedAt: number | null;
  /** The user's own description: wins over Claude's and is never overwritten. */
  note: string | null;
  local: LocalFacts | null;
  claude: ClaudeDescription | null;
  job: DescribeJob;
  remembered: RememberedSetup | null;
  /** The folder wasn't found the last time Atelier looked (moved or deleted outside Atelier). */
  missing: boolean;
}

export interface Collection {
  id: string;
  name: string;
  color: string | null;
}

/** A folder projects are moved into (Steam's "library folders"): any drive. */
export interface LibraryFolder {
  id: string;
  path: string;
}

export interface Library {
  version: 1;
  /** In the user's order. */
  collections: Collection[];
  folders: LibraryFolder[];
  entries: LibraryEntry[];
}

export const EMPTY_LIBRARY: Library = { version: 1, collections: [], folders: [], entries: [] };

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_NAME_LENGTH = 120;
export const DESCRIBE_ATTEMPTS = 3;

// ───────────── Tolerant loading ─────────────

const Id = z.string().min(1).max(64);
const num = z.number().finite();
const Str = (max: number) => z.string().transform((s) => s.slice(0, max));
const Kind = z.enum(PROJECT_KINDS);
const stringList = (maxItems: number, maxLen: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((a) =>
      a
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, maxLen))
        .slice(0, maxItems),
    );

const RawLocal = z.object({
  stack: stringList(16, 40),
  languages: z
    .array(z.object({ name: Str(40), files: z.number().int().nonnegative() }))
    .catch([])
    .transform((a) => a.slice(0, 12)),
  kind: Kind.nullable().catch(null),
  summary: Str(600).nullable().catch(null),
  git: z
    .object({
      branch: Str(200).nullable().catch(null),
      worktree: z.boolean().catch(false),
      lastCommitAt: num.nullable().catch(null),
    })
    .nullable()
    .catch(null),
  modifiedAt: num.nullable().catch(null),
  isCode: z.boolean().catch(true),
  analyzedAt: num.catch(0),
});

const RawClaude = z.object({
  text: Str(600),
  stack: stringList(12, 32),
  kind: Kind.catch('other'),
  model: Str(64).catch(''),
  at: num.catch(0),
});

const RawJob = z.object({
  state: z.enum(['none', 'queued', 'running', 'done', 'error', 'unavailable', 'auth']).catch('none'),
  attempts: z.number().int().nonnegative().catch(0),
  error: Str(300).optional().catch(undefined),
});

const RawEntry = z.object({
  id: Id,
  path: z.string().min(1),
  name: z.string().catch(''),
  color: z.unknown().optional().transform(normalizeColor),
  collectionId: Id.nullable().catch(null),
  tags: stringList(MAX_TAGS, MAX_TAG_LENGTH),
  favorite: z.boolean().catch(false),
  status: z.enum(['active', 'paused', 'archived']).catch('active'),
  addedAt: num.catch(0),
  lastOpenedAt: num.nullable().catch(null),
  note: Str(MAX_NOTE_LENGTH).nullable().catch(null),
  local: RawLocal.nullable().catch(null),
  claude: RawClaude.nullable().catch(null),
  job: RawJob.catch({ state: 'none', attempts: 0 }),
  remembered: z
    .object({ terminals: z.array(z.unknown()).catch([]), layout: z.unknown() })
    .nullable()
    .catch(null),
  missing: z.boolean().catch(false),
});

const RawCollection = z.object({
  id: Id,
  name: z.string().min(1).catch('Collection'),
  color: z.unknown().optional().transform(normalizeColor),
});

const RawFolder = z.object({ id: Id, path: z.string().min(1) });

/** Invalid entries are dropped, never the whole file. Terminal ids must not repeat across remembered setups. */
export function parseLibrary(raw: unknown): Library {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const collections: Collection[] = [];
  const seenCollections = new Set<string>();
  for (const c of Array.isArray(obj.collections) ? obj.collections : []) {
    const r = RawCollection.safeParse(c);
    if (!r.success || seenCollections.has(r.data.id)) continue;
    seenCollections.add(r.data.id);
    collections.push({ id: r.data.id, name: r.data.name.slice(0, MAX_NAME_LENGTH), color: r.data.color });
  }

  const folders: LibraryFolder[] = [];
  const seenFolders = new Set<string>();
  for (const f of Array.isArray(obj.folders) ? obj.folders : []) {
    const r = RawFolder.safeParse(f);
    if (!r.success) continue;
    const key = pathIdentity(r.data.path);
    if (seenFolders.has(key) || folders.some((x) => x.id === r.data.id)) continue;
    seenFolders.add(key);
    folders.push(r.data);
  }

  const entries: LibraryEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const seenTerminals = new Set<string>();
  for (const e of Array.isArray(obj.entries) ? obj.entries : []) {
    const r = RawEntry.safeParse(e);
    if (!r.success) continue;
    const key = pathIdentity(r.data.path);
    if (seenIds.has(r.data.id) || seenPaths.has(key)) continue;
    seenIds.add(r.data.id);
    seenPaths.add(key);
    let remembered: RememberedSetup | null = null;
    if (r.data.remembered) {
      const terminals = parseTerminals(r.data.remembered.terminals, seenTerminals);
      if (terminals.length > 0)
        remembered = { terminals, layout: parseLayout(r.data.remembered.layout, terminals) };
    }
    // A job that was running when Atelier quit runs again.
    const job: DescribeJob = r.data.job.state === 'running' ? { ...r.data.job, state: 'queued' } : r.data.job;
    entries.push({
      ...r.data,
      name: (r.data.name.trim() || baseName(r.data.path)).slice(0, MAX_NAME_LENGTH),
      tags: normalizeTags(r.data.tags),
      collectionId:
        r.data.collectionId && seenCollections.has(r.data.collectionId) ? r.data.collectionId : null,
      job,
      remembered,
    });
  }
  return { version: 1, collections, folders, entries };
}

/** Trimmed, deduplicated case-insensitively (first spelling wins), capped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function newEntry(id: string, path: string, now: number, name?: string): LibraryEntry {
  return {
    id,
    path,
    name: (name?.trim() || baseName(path)).slice(0, MAX_NAME_LENGTH),
    color: null,
    collectionId: null,
    tags: [],
    favorite: false,
    status: 'active',
    addedAt: now,
    lastOpenedAt: null,
    note: null,
    local: null,
    claude: null,
    job: { state: 'none', attempts: 0 },
    remembered: null,
    missing: false,
  };
}

export function findByPath(lib: Library, path: string): LibraryEntry | null {
  const key = pathIdentity(path);
  return lib.entries.find((e) => pathIdentity(e.path) === key) ?? null;
}

// ───────────── Operations (renderer → main) ─────────────

export type LibraryOp =
  | { op: 'rename'; id: string; name: string }
  | { op: 'color'; id: string; color: string | null }
  | { op: 'collection'; ids: string[]; collectionId: string | null }
  | { op: 'tags'; ids: string[]; add?: string[]; remove?: string[] }
  | { op: 'setTags'; id: string; tags: string[] }
  | { op: 'favorite'; ids: string[]; value: boolean }
  | { op: 'status'; ids: string[]; value: EntryStatus }
  | { op: 'note'; id: string; note: string | null }
  | { op: 'remove'; ids: string[] }
  | { op: 'opened'; id: string; at: number }
  | { op: 'remember'; id: string; remembered: RememberedSetup | null }
  | { op: 'collectionAdd'; id: string; name: string; color?: string | null }
  | { op: 'collectionRename'; id: string; name: string }
  | { op: 'collectionColor'; id: string; color: string | null }
  | { op: 'collectionRemove'; id: string }
  | { op: 'collectionMove'; id: string; toIndex: number }
  | { op: 'folderAdd'; id: string; path: string }
  | { op: 'folderRemove'; id: string };

const Ids = z.array(Id).max(5000);
const Name = z.string().max(500);
const ColorIn = z.string().nullable();
const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), id: Id, name: Name }),
  z.object({ op: z.literal('color'), id: Id, color: ColorIn }),
  z.object({ op: z.literal('collection'), ids: Ids, collectionId: Id.nullable() }),
  z.object({
    op: z.literal('tags'),
    ids: Ids,
    add: z.array(Name).max(MAX_TAGS).optional(),
    remove: z.array(Name).max(500).optional(),
  }),
  z.object({ op: z.literal('setTags'), id: Id, tags: z.array(Name).max(500) }),
  z.object({ op: z.literal('favorite'), ids: Ids, value: z.boolean() }),
  z.object({ op: z.literal('status'), ids: Ids, value: z.enum(['active', 'paused', 'archived']) }),
  z.object({
    op: z.literal('note'),
    id: Id,
    note: z
      .string()
      .max(MAX_NOTE_LENGTH * 2)
      .nullable(),
  }),
  z.object({ op: z.literal('remove'), ids: Ids }),
  z.object({ op: z.literal('opened'), id: Id, at: z.number().finite() }),
  z.object({
    op: z.literal('remember'),
    id: Id,
    remembered: z.object({ terminals: z.array(z.unknown()).max(200), layout: z.unknown() }).nullable(),
  }),
  z.object({ op: z.literal('collectionAdd'), id: Id, name: Name, color: ColorIn.optional() }),
  z.object({ op: z.literal('collectionRename'), id: Id, name: Name }),
  z.object({ op: z.literal('collectionColor'), id: Id, color: ColorIn }),
  z.object({ op: z.literal('collectionRemove'), id: Id }),
  z.object({ op: z.literal('collectionMove'), id: Id, toIndex: z.number().finite() }),
  z.object({ op: z.literal('folderAdd'), id: Id, path: z.string().min(1).max(4000) }),
  z.object({ op: z.literal('folderRemove'), id: Id }),
]);

/** An operation from the renderer, checked; null when it isn't one. Remembered terminals are re-validated. */
export function parseOp(raw: unknown): LibraryOp | null {
  const r = OpSchema.safeParse(raw);
  if (!r.success) return null;
  const o = r.data;
  if (o.op === 'remember') {
    if (!o.remembered) return { op: 'remember', id: o.id, remembered: null };
    const terminals = parseTerminals(o.remembered.terminals);
    return {
      op: 'remember',
      id: o.id,
      remembered: terminals.length
        ? { terminals, layout: parseLayout(o.remembered.layout, terminals) }
        : null,
    };
  }
  return o as LibraryOp;
}

function mapEntries(lib: Library, ids: readonly string[], fn: (e: LibraryEntry) => LibraryEntry): Library {
  const set = new Set(ids);
  return { ...lib, entries: lib.entries.map((e) => (set.has(e.id) ? fn(e) : e)) };
}

/**
 * Applies an operation; invalid ones (unknown ids, empty names, a folder already in the list) leave the library
 * unchanged. Pure: main validates the op's shape before calling this and persists the result.
 */
export function applyOp(lib: Library, o: LibraryOp): Library {
  switch (o.op) {
    case 'rename': {
      const name = o.name.trim().slice(0, MAX_NAME_LENGTH);
      return name ? mapEntries(lib, [o.id], (e) => ({ ...e, name })) : lib;
    }
    case 'color':
      return mapEntries(lib, [o.id], (e) => ({ ...e, color: normalizeColor(o.color) }));
    case 'collection': {
      if (o.collectionId !== null && !lib.collections.some((c) => c.id === o.collectionId)) return lib;
      return mapEntries(lib, o.ids, (e) => ({ ...e, collectionId: o.collectionId }));
    }
    case 'tags': {
      const remove = new Set((o.remove ?? []).map((t) => t.trim().toLowerCase()));
      return mapEntries(lib, o.ids, (e) => ({
        ...e,
        tags: normalizeTags([...e.tags.filter((t) => !remove.has(t.toLowerCase())), ...(o.add ?? [])]),
      }));
    }
    case 'setTags':
      return mapEntries(lib, [o.id], (e) => ({ ...e, tags: normalizeTags(o.tags) }));
    case 'favorite':
      return mapEntries(lib, o.ids, (e) => ({ ...e, favorite: o.value }));
    case 'status':
      return mapEntries(lib, o.ids, (e) => ({ ...e, status: o.value }));
    case 'note': {
      const note = o.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
      return mapEntries(lib, [o.id], (e) => ({ ...e, note }));
    }
    case 'remove': {
      const set = new Set(o.ids);
      return { ...lib, entries: lib.entries.filter((e) => !set.has(e.id)) };
    }
    case 'opened':
      return mapEntries(lib, [o.id], (e) => ({ ...e, lastOpenedAt: o.at }));
    case 'remember':
      return mapEntries(lib, [o.id], (e) => ({ ...e, remembered: o.remembered }));
    case 'collectionAdd': {
      const name = o.name.trim().slice(0, MAX_NAME_LENGTH);
      if (!name || lib.collections.some((c) => c.id === o.id)) return lib;
      return {
        ...lib,
        collections: [...lib.collections, { id: o.id, name, color: normalizeColor(o.color) }],
      };
    }
    case 'collectionRename': {
      const name = o.name.trim().slice(0, MAX_NAME_LENGTH);
      if (!name) return lib;
      return { ...lib, collections: lib.collections.map((c) => (c.id === o.id ? { ...c, name } : c)) };
    }
    case 'collectionColor':
      return {
        ...lib,
        collections: lib.collections.map((c) =>
          c.id === o.id ? { ...c, color: normalizeColor(o.color) } : c,
        ),
      };
    case 'collectionRemove':
      // Its projects go back to the Inbox; nothing is deleted.
      return {
        ...lib,
        collections: lib.collections.filter((c) => c.id !== o.id),
        entries: lib.entries.map((e) => (e.collectionId === o.id ? { ...e, collectionId: null } : e)),
      };
    case 'collectionMove': {
      const from = lib.collections.findIndex((c) => c.id === o.id);
      if (from < 0) return lib;
      const collections = [...lib.collections];
      const [moved] = collections.splice(from, 1);
      collections.splice(Math.max(0, Math.min(collections.length, Math.round(o.toIndex))), 0, moved!);
      return { ...lib, collections };
    }
    case 'folderAdd': {
      const key = pathIdentity(o.path);
      if (lib.folders.some((f) => f.id === o.id || pathIdentity(f.path) === key)) return lib;
      return { ...lib, folders: [...lib.folders, { id: o.id, path: o.path }] };
    }
    case 'folderRemove':
      return { ...lib, folders: lib.folders.filter((f) => f.id !== o.id) };
  }
}

// ───────────── Paths ─────────────

/** `path` with its `oldRoot` prefix replaced by `newRoot`; unchanged when it isn't inside `oldRoot`. */
export function rebasePath(path: string, oldRoot: string, newRoot: string): string {
  if (!isInsidePath(path, oldRoot)) return path;
  const trimmed = oldRoot.replace(/[\\/]+$/, '');
  const rest = path.slice(trimmed.length).replace(/^[\\/]+/, '');
  if (!rest) return newRoot;
  const sep = newRoot.includes('\\') || /^[a-z]:/i.test(newRoot) ? '\\' : '/';
  const norm = sep === '\\' ? rest.replace(/\//g, '\\') : rest.replace(/\\/g, '/');
  return newRoot.replace(/[\\/]+$/, '') + sep + norm;
}

function rebaseTerminals(terminals: TerminalSpec[], oldRoot: string, newRoot: string): TerminalSpec[] {
  return terminals.map((t) =>
    t.lastCwd && isInsidePath(t.lastCwd, oldRoot)
      ? { ...t, lastCwd: rebasePath(t.lastCwd, oldRoot, newRoot) }
      : t,
  );
}

/** A folder moved: every entry inside it (itself, nested projects) and every remembered terminal follow. */
export function rebaseLibrary(lib: Library, oldRoot: string, newRoot: string): Library {
  return {
    ...lib,
    folders: lib.folders,
    entries: lib.entries.map((e) => ({
      ...e,
      path: rebasePath(e.path, oldRoot, newRoot),
      remembered: e.remembered
        ? { ...e.remembered, terminals: rebaseTerminals(e.remembered.terminals, oldRoot, newRoot) }
        : null,
    })),
  };
}

/** The same for the open projects (their path and their terminals' last folders, in every project). */
export function rebaseWorkspace<W extends { projects: { path: string; terminals: TerminalSpec[] }[] }>(
  ws: W,
  oldRoot: string,
  newRoot: string,
): W {
  return {
    ...ws,
    projects: ws.projects.map((p) => ({
      ...p,
      path: rebasePath(p.path, oldRoot, newRoot),
      terminals: rebaseTerminals(p.terminals, oldRoot, newRoot),
    })),
  };
}

// ───────────── Views (filter, sort) ─────────────

export type LibraryScope =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'inbox' }
  | { kind: 'archived' }
  | { kind: 'collection'; id: string };

export type LibrarySort = 'recent' | 'name' | 'modified' | 'added';

export interface LibraryFilter {
  scope: LibraryScope;
  query: string;
  tags: string[];
  stack: string[];
}

/** The stack shown for an entry: Claude's when it has one, else the local analysis'. */
export function entryStack(e: LibraryEntry): string[] {
  return e.claude?.stack.length ? e.claude.stack : (e.local?.stack ?? []);
}

/** The description shown: the user's note, Claude's text, then the folder's own summary. */
export function entryDescription(e: LibraryEntry): string | null {
  return e.note ?? e.claude?.text ?? e.local?.summary ?? null;
}

const RECENT_LIMIT = 24;

export function inScope(e: LibraryEntry, scope: LibraryScope): boolean {
  // Archived projects only show in the Archive (and when searched for by collection).
  switch (scope.kind) {
    case 'all':
      return e.status !== 'archived';
    case 'favorites':
      return e.favorite && e.status !== 'archived';
    case 'recent':
      return e.lastOpenedAt !== null && e.status !== 'archived';
    case 'inbox':
      return e.collectionId === null && e.status !== 'archived';
    case 'archived':
      return e.status === 'archived';
    case 'collection':
      return e.collectionId === scope.id && e.status !== 'archived';
  }
}

export function filterEntries(entries: readonly LibraryEntry[], f: LibraryFilter): LibraryEntry[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const tags = f.tags.map((t) => t.toLowerCase());
  const stack = f.stack.map((t) => t.toLowerCase());
  return entries.filter((e) => {
    if (!inScope(e, f.scope)) return false;
    const eTags = e.tags.map((t) => t.toLowerCase());
    if (!tags.every((t) => eTags.includes(t))) return false;
    const eStack = entryStack(e).map((t) => t.toLowerCase());
    if (!stack.every((t) => eStack.includes(t))) return false;
    if (words.length === 0) return true;
    const hay = [e.name, e.path, entryDescription(e) ?? '', ...e.tags, ...entryStack(e)]
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function sortEntries(
  entries: readonly LibraryEntry[],
  sort: LibrarySort,
  scope?: LibraryScope,
): LibraryEntry[] {
  const byName = (a: LibraryEntry, b: LibraryEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const desc = (f: (e: LibraryEntry) => number | null) => (a: LibraryEntry, b: LibraryEntry) =>
    (f(b) ?? -1) - (f(a) ?? -1) || byName(a, b);
  const sorted = [...entries];
  switch (sort) {
    case 'name':
      sorted.sort(byName);
      break;
    case 'recent':
      sorted.sort(desc((e) => e.lastOpenedAt ?? e.addedAt));
      break;
    case 'modified':
      sorted.sort(desc((e) => Math.max(e.local?.modifiedAt ?? 0, e.local?.git?.lastCommitAt ?? 0) || null));
      break;
    case 'added':
      sorted.sort(desc((e) => e.addedAt));
      break;
  }
  return scope?.kind === 'recent' ? sorted.slice(0, RECENT_LIMIT) : sorted;
}

/** Every tag / stack item in use, most used first (the filter menus). */
export function facets(entries: readonly LibraryEntry[]): { tags: string[]; stack: string[] } {
  const count = (lists: string[][]) => {
    const m = new Map<string, { label: string; n: number }>();
    for (const list of lists)
      for (const item of list) {
        const k = item.toLowerCase();
        const cur = m.get(k);
        if (cur) cur.n++;
        else m.set(k, { label: item, n: 1 });
      }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((x) => x.label);
  };
  return { tags: count(entries.map((e) => e.tags)), stack: count(entries.map(entryStack)) };
}
