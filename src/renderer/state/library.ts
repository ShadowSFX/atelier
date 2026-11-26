import { create } from 'zustand';
import {
  EMPTY_LIBRARY,
  rebaseWorkspace,
  type EntryStatus,
  type Library,
  type LibraryEntry,
  type LibraryOp,
  type LibraryScope,
  type LibrarySort,
} from '@shared/library';
import { joinPath, type MoveProgress } from '@shared/move';
import { api } from '../lib/api';
import { getController, restartTerminal } from '../terminal/registry';
import { confirmDialog, promptDialog, t, toast } from './app';
import {
  closeProject,
  newId,
  renameProject,
  saveWorkspaceNow,
  setProjectColor,
  useWorkspace,
} from './workspace';

/** The project library, as main last sent it (main owns it; every change goes through `op`). */
export const useLibrary = create<Library>(() => EMPTY_LIBRARY);

/** Moves in progress or just finished, by entry id (cards and panes show them). */
export const useMoves = create<Record<string, MoveProgress>>(() => ({}));

export interface LibraryView {
  open: boolean;
  scope: LibraryScope;
  query: string;
  tags: string[];
  stack: string[];
  sort: LibrarySort;
  layout: 'grid' | 'list';
  selected: string[];
  /** Entry whose Move dialog is open. */
  moving: string | null;
  importOpen: boolean;
  /** Folder the scan dialog starts on (the empty library's "Scan your Desktop"). */
  scanDir: string | null;
}

const VIEW_KEY = 'atelier.library.view';

function savedView(): Pick<LibraryView, 'sort' | 'layout'> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<LibraryView>;
    return {
      sort: (['recent', 'name', 'modified', 'added'] as const).includes(v.sort as LibrarySort)
        ? (v.sort as LibrarySort)
        : 'recent',
      layout: v.layout === 'list' ? 'list' : 'grid',
    };
  } catch {
    return { sort: 'recent', layout: 'grid' };
  }
}

export const useLibraryView = create<LibraryView>(() => ({
  open: false,
  scope: { kind: 'all' },
  query: '',
  tags: [],
  stack: [],
  ...savedView(),
  selected: [],
  moving: null,
  importOpen: false,
  scanDir: null,
}));

useLibraryView.subscribe((v, prev) => {
  if (v.sort !== prev.sort || v.layout !== prev.layout)
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: v.sort, layout: v.layout }));
});

export function openLibrary(open = true): void {
  useLibraryView.setState({ open });
  if (open) void api.invoke('library:refresh');
}

export function toggleLibrary(): void {
  openLibrary(!useLibraryView.getState().open);
}

export function entryById(id: string): LibraryEntry | null {
  return useLibrary.getState().entries.find((e) => e.id === id) ?? null;
}

// ───────────── Loading and main's events ─────────────

/** Terminals a move stopped (by move id): only these start again if the move is called off. */
const suspended = new Map<string, string[]>();

export async function loadLibrary(): Promise<void> {
  useLibrary.setState(await api.invoke('library:load'), true);
  api.on('library:changed', (lib) => {
    useLibrary.setState(lib, true);
    // Selection never points at entries that are gone.
    const ids = new Set(lib.entries.map((e) => e.id));
    const v = useLibraryView.getState();
    if (v.selected.some((id) => !ids.has(id)))
      useLibraryView.setState({ selected: v.selected.filter((id) => ids.has(id)) });
  });
  api.on('move:progress', onMoveProgress);
  api.on('move:suspend', (moveId, ids) => void onSuspend(moveId, ids));
  api.on('move:committed', (moveId, from, to, ids) => void onCommitted(moveId, from, to, ids));
  api.on('move:aborted', (moveId, ids) => {
    const stopped = new Set(suspended.get(moveId) ?? []);
    suspended.delete(moveId);
    for (const id of ids) if (stopped.has(id)) restartTerminal(id);
  });
}

function onMoveProgress(p: MoveProgress): void {
  useMoves.setState({ [p.entryId]: p });
  const name = entryById(p.entryId)?.name ?? '';
  if (p.phase === 'done') {
    toast(t('move.done', name, p.destination), 'success');
    if (p.notes?.length) toast(p.notes.map((n) => t(noteKey(n))).join(' '), 'info');
  } else if (p.phase === 'failed') toast(t('move.failed', name, moveError(p.error)), 'error');
  else if (p.phase === 'cancelled') toast(t('move.cancelled', name));
  if (p.phase === 'done' || p.phase === 'failed' || p.phase === 'cancelled')
    setTimeout(() => {
      if (useMoves.getState()[p.entryId] === p) {
        const next = { ...useMoves.getState() };
        delete next[p.entryId];
        useMoves.setState(next, true);
      }
    }, 4000);
}

function noteKey(n: string) {
  return n === 'git-failed'
    ? 'move.noteGit'
    : n === 'git-missing'
      ? 'move.noteGitMissing'
      : 'move.noteClaude';
}

export function moveError(code: string | undefined): string {
  switch (code) {
    case 'in-use':
      return t('move.errInUse');
    case 'no-space':
      return t('move.errSpace');
    case 'verify':
      return t('move.errVerify');
    case 'dest-exists':
      return t('move.errExists');
    case 'source-missing':
      return t('move.errMissing');
    default:
      return code?.startsWith('error:') ? code.slice(6) : (code ?? '');
  }
}

/** Main is about to stop these terminals: their screens are saved (a crash mid-move still restores them). */
async function onSuspend(moveId: string, ids: string[]): Promise<void> {
  suspended.set(moveId, ids);
  await Promise.all(
    ids.map((id) => {
      const c = getController(id);
      return c ? api.invoke('snapshot:write', id, c.snapshot()).catch(() => undefined) : Promise.resolve();
    }),
  );
  void api.invoke('move:suspended', moveId);
}

/** The folder moved: every path inside it follows, then the stopped terminals start again there. */
async function onCommitted(moveId: string, from: string, to: string, ids: string[]): Promise<void> {
  useWorkspace.setState((ws) => rebaseWorkspace(ws, from, to));
  await saveWorkspaceNow();
  void api.invoke('move:applied', moveId);
  const stopped = new Set(suspended.get(moveId) ?? ids);
  suspended.delete(moveId);
  for (const id of ids) if (stopped.has(id)) restartTerminal(id);
}

// ───────────── Operations ─────────────

export async function op(o: LibraryOp): Promise<void> {
  try {
    useLibrary.setState(await api.invoke('library:update', o), true);
  } catch {
    toast(t('library.opFailed'), 'error');
  }
}

const isOpen = (id: string) => useWorkspace.getState().projects.some((p) => p.id === id);

export function renameEntry(id: string, name: string): void {
  const clean = name.trim();
  if (!clean) return;
  void op({ op: 'rename', id, name: clean });
  if (isOpen(id)) renameProject(id, clean, false);
}

export function setEntryColor(id: string, color: string | null): void {
  void op({ op: 'color', id, color });
  if (isOpen(id)) setProjectColor(id, color, false);
}

export async function renameEntryFlow(e: LibraryEntry): Promise<void> {
  const name = await promptDialog({ title: t('projects.rename'), value: e.name, ok: t('common.rename') });
  if (name) renameEntry(e.id, name);
}

export async function editTagsFlow(ids: string[]): Promise<void> {
  const entries = ids.map(entryById).filter((e): e is LibraryEntry => !!e);
  if (entries.length === 0) return;
  // One project: edit its list. Several: add to all of them.
  const single = entries.length === 1 ? entries[0]! : null;
  const value = await promptDialog({
    title: single ? t('library.tagsTitle', single.name) : t('library.tagsAddTitle', entries.length),
    value: single ? single.tags.join(', ') : '',
    ok: t('common.save'),
    body: t('library.tagsHint'),
    allowEmpty: !!single,
  });
  if (value === null) return;
  const tags = value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (single) void op({ op: 'setTags', id: single.id, tags });
  else void op({ op: 'tags', ids, add: tags });
}

export async function editNoteFlow(e: LibraryEntry): Promise<void> {
  const value = await promptDialog({
    title: t('library.noteTitle', e.name),
    value: e.note ?? e.claude?.text ?? '',
    ok: t('common.save'),
    body: t('library.noteHint'),
    allowEmpty: true,
    multiline: true,
  });
  if (value !== null) void op({ op: 'note', id: e.id, note: value.trim() || null });
}

export function setFavorite(ids: string[], value: boolean): void {
  void op({ op: 'favorite', ids, value });
}

export function setStatus(ids: string[], value: EntryStatus): void {
  void op({ op: 'status', ids, value });
}

export function setCollection(ids: string[], collectionId: string | null): void {
  void op({ op: 'collection', ids, collectionId });
}

export function describeAgain(ids: string[]): void {
  void api.invoke('library:describe', ids);
}

/** Forgets projects (their folders stay where they are). Open ones close first. */
export async function removeEntries(ids: string[]): Promise<void> {
  const entries = ids.map(entryById).filter((e): e is LibraryEntry => !!e);
  if (entries.length === 0) return;
  const ok = await confirmDialog({
    title:
      entries.length === 1
        ? t('library.removeOne', entries[0]!.name)
        : t('library.removeMany', entries.length),
    body: t('library.removeBody'),
    ok: t('library.remove'),
    danger: true,
  });
  if (!ok) return;
  for (const e of entries) if (isOpen(e.id)) await closeProject(e.id, { forget: true, confirm: false });
  void op({ op: 'remove', ids: entries.map((e) => e.id) });
  useLibraryView.setState((v) => ({ selected: v.selected.filter((id) => !ids.includes(id)) }));
}

export async function newCollectionFlow(assign: string[] = []): Promise<void> {
  const name = await promptDialog({ title: t('library.newCollection'), value: '', ok: t('library.create') });
  if (!name?.trim()) return;
  const id = newId('c');
  await op({ op: 'collectionAdd', id, name: name.trim() });
  if (assign.length) setCollection(assign, id);
}

export async function renameCollectionFlow(id: string): Promise<void> {
  const c = useLibrary.getState().collections.find((x) => x.id === id);
  if (!c) return;
  const name = await promptDialog({
    title: t('library.renameCollection'),
    value: c.name,
    ok: t('common.rename'),
  });
  if (name?.trim()) void op({ op: 'collectionRename', id, name: name.trim() });
}

export async function removeCollectionFlow(id: string): Promise<void> {
  const c = useLibrary.getState().collections.find((x) => x.id === id);
  if (!c) return;
  const count = useLibrary.getState().entries.filter((e) => e.collectionId === id).length;
  const ok = await confirmDialog({
    title: t('library.removeCollection', c.name),
    body: count ? t('library.removeCollectionBody', count) : undefined,
    ok: t('library.remove'),
    danger: true,
  });
  if (!ok) return;
  void op({ op: 'collectionRemove', id });
  const v = useLibraryView.getState();
  if (v.scope.kind === 'collection' && v.scope.id === id) useLibraryView.setState({ scope: { kind: 'all' } });
}

export async function addLibraryFolderFlow(): Promise<void> {
  const path = await api.invoke('dialog:pick-folder', t('library.folderPick'));
  if (path) void op({ op: 'folderAdd', id: newId('f'), path });
}

export async function locateFlow(e: LibraryEntry): Promise<void> {
  const path = await api.invoke('dialog:pick-folder', t('library.locateTitle', e.name));
  if (!path) return;
  const found = await api.invoke('library:locate', e.id, path);
  if (!found) toast(t('library.locateFailed'), 'error');
}

export function startMove(entryId: string): void {
  useLibraryView.setState({ moving: entryId });
}

function waitForMove(entryId: string, moveId: string): Promise<MoveProgress> {
  return new Promise((resolve) => {
    const check = (m: Record<string, MoveProgress>) => {
      const p = m[entryId];
      if (p && p.id === moveId && ['done', 'failed', 'cancelled'].includes(p.phase)) {
        off();
        resolve(p);
      }
    };
    const off = useMoves.subscribe(check);
    check(useMoves.getState());
  });
}

let bulkRunning = false;

/**
 * Moves several projects into a library folder, one after another (each keeps its folder name). Projects that
 * can't move (the name is taken there, a protected folder…) are skipped and counted.
 */
export async function moveMany(ids: string[], folder: string): Promise<void> {
  if (bulkRunning) return toast(t('move.bBusy'), 'error');
  bulkRunning = true;
  let moved = 0;
  let skipped = 0;
  try {
    for (const id of ids) {
      const e = entryById(id);
      if (!e || e.missing) {
        skipped++;
        continue;
      }
      const name =
        e.path
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? e.name;
      const plan = await api.invoke('move:plan', id, joinPath(folder, name));
      if (plan.blockers.length > 0) {
        skipped++;
        continue;
      }
      if (!(await api.invoke('move:start', plan.id, true))) {
        skipped++;
        continue;
      }
      const end = await waitForMove(id, plan.id);
      if (end.phase === 'done') moved++;
      else skipped++;
    }
  } finally {
    bulkRunning = false;
  }
  toast(t('move.bulkDone', moved, skipped), skipped ? 'info' : 'success');
}
