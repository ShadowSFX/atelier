import {
  Add16Regular,
  Archive16Regular,
  ArrowSort16Regular,
  ArrowSync16Regular,
  Delete16Regular,
  Dismiss12Regular,
  Edit16Regular,
  Filter16Regular,
  FolderAdd16Regular,
  FolderArrowRight16Regular,
  FolderOpen16Regular,
  FolderSearch16Regular,
  Grid16Regular,
  HardDrive16Regular,
  History16Regular,
  LocationArrow16Regular,
  MailInbox16Regular,
  Open16Regular,
  Pause16Regular,
  Play16Regular,
  Rename16Regular,
  Search16Regular,
  Sparkle16Regular,
  Star16Filled,
  Star16Regular,
  Tag16Regular,
  TextBulletList16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  facets,
  filterEntries,
  inScope,
  sortEntries,
  type Collection,
  type LibraryEntry,
  type LibraryScope,
  type LibrarySort,
} from '@shared/library';
import { joinPath } from '@shared/move';
import { Button, cx, IconButton } from '../../components/Button';
import { ColorSwatches } from '../../components/Overlays';
import { api } from '../../lib/api';
import { bytes, shortPath } from '../../lib/format';
import { openMenu, t, useApp, useT, type MenuEntry } from '../../state/app';
import {
  addLibraryFolderFlow,
  describeAgain,
  editNoteFlow,
  editTagsFlow,
  entryById,
  locateFlow,
  newCollectionFlow,
  op,
  removeCollectionFlow,
  removeEntries,
  renameCollectionFlow,
  renameEntryFlow,
  setCollection,
  setEntryColor,
  setFavorite,
  moveMany,
  setStatus,
  startMove,
  useLibrary,
  useLibraryView,
} from '../../state/library';
import { closeProject, openFromLibrary, pickAndAddProject, useWorkspace } from '../../state/workspace';
import { LIBRARY_DRAG, ProjectCard } from './ProjectCard';
import s from './Library.module.css';

const COLLECTION_DRAG = 'application/x-atelier-collection';

const sameScope = (a: LibraryScope, b: LibraryScope) =>
  a.kind === b.kind && (a.kind !== 'collection' || (b.kind === 'collection' && a.id === b.id));

// ───────────── Menus ─────────────

function collectionMenu(c: Collection, x: number, y: number): void {
  openMenu(x, y, [
    {
      label: t('library.renameCollection'),
      icon: <Rename16Regular />,
      run: () => void renameCollectionFlow(c.id),
    },
    {
      label: t('projects.color'),
      custom: (
        <ColorSwatches
          value={c.color}
          onPick={(color) => void op({ op: 'collectionColor', id: c.id, color })}
        />
      ),
    },
    'separator',
    {
      label: t('library.removeCollectionMenu'),
      icon: <Delete16Regular />,
      danger: true,
      run: () => void removeCollectionFlow(c.id),
    },
  ]);
}

/** The context menu of one card, or of the selection when several are selected. */
export function entryMenu(ids: string[], x: number, y: number): void {
  const entries = ids.map(entryById).filter((e): e is LibraryEntry => !!e);
  if (entries.length === 0) return;
  const lib = useLibrary.getState();
  const one = entries.length === 1 ? entries[0]! : null;
  const open = one ? useWorkspace.getState().projects.some((p) => p.id === one.id) : false;
  const collections: MenuEntry[] = [
    {
      label: t('library.inbox'),
      icon: <MailInbox16Regular />,
      checked: entries.every((e) => e.collectionId === null),
      run: () => setCollection(ids, null),
    },
    ...lib.collections.map((c): MenuEntry => ({
      label: c.name,
      icon: <span className={s.dot} style={c.color ? { background: c.color } : undefined} />,
      checked: entries.every((e) => e.collectionId === c.id),
      run: () => setCollection(ids, c.id),
    })),
    { label: t('library.newCollectionMenu'), icon: <Add16Regular />, run: () => void newCollectionFlow(ids) },
  ];
  const allFav = entries.every((e) => e.favorite);
  const archived = entries.every((e) => e.status === 'archived');
  const items: MenuEntry[] = [];
  if (one) {
    if (one.missing)
      items.push({
        label: t('library.locate'),
        icon: <LocationArrow16Regular />,
        run: () => void locateFlow(one),
      });
    else
      items.push({
        label: open ? t('library.show') : t('library.open'),
        icon: <Open16Regular />,
        shortcut: 'Enter',
        run: () => void openFromLibrary(one.id),
      });
    items.push(
      {
        label: t('library.moveTo'),
        icon: <FolderArrowRight16Regular />,
        disabled: one.missing,
        run: () => startMove(one.id),
      },
      'separator',
      {
        label: t('projects.rename'),
        icon: <Rename16Regular />,
        shortcut: 'F2',
        run: () => void renameEntryFlow(one),
      },
      { label: t('library.editNote'), icon: <Edit16Regular />, run: () => void editNoteFlow(one) },
      {
        label: t('projects.color'),
        custom: <ColorSwatches value={one.color} onPick={(c) => setEntryColor(one.id, c)} />,
      },
    );
  }
  items.push(
    ...(lib.folders.length > 0 && entries.some((e) => !e.missing)
      ? lib.folders.map((f): MenuEntry => ({
          label: t('library.moveInto', shortPath(f.path, useApp.getState().home)),
          icon: <HardDrive16Regular />,
          run: () => void moveMany(ids, f.path),
        }))
      : []),
    { label: t('library.tags'), icon: <Tag16Regular />, run: () => void editTagsFlow(ids) },
    {
      label: allFav ? t('library.unfavorite') : t('library.favorite'),
      icon: allFav ? <Star16Regular /> : <Star16Filled />,
      run: () => setFavorite(ids, !allFav),
    },
    'separator',
    { label: t('library.collectionTitle'), icon: <FolderAdd16Regular />, disabled: true },
    ...collections,
    'separator',
    {
      label: archived ? t('library.unarchive') : t('library.archive'),
      icon: <Archive16Regular />,
      run: () => setStatus(ids, archived ? 'active' : 'archived'),
    },
    ...(entries.some((e) => e.status !== 'paused' && e.status !== 'archived')
      ? [{ label: t('library.pause'), icon: <Pause16Regular />, run: () => setStatus(ids, 'paused') }]
      : entries.some((e) => e.status === 'paused')
        ? [{ label: t('library.resume'), icon: <Play16Regular />, run: () => setStatus(ids, 'active') }]
        : []),
    {
      label: t('library.describeAgain'),
      icon: <Sparkle16Regular />,
      disabled: entries.some((e) => e.job.state === 'running'),
      run: () => describeAgain(ids),
    },
  );
  if (one && !one.missing)
    items.push({
      label: t('projects.reveal'),
      icon: <FolderOpen16Regular />,
      run: () => void api.invoke('shell:open-path', one.path),
    });
  if (one && open)
    items.push({
      label: t('projects.close'),
      icon: <Dismiss12Regular />,
      run: () => void closeProject(one.id),
    });
  items.push('separator', {
    label: entries.length > 1 ? t('library.removeManyMenu', entries.length) : t('library.removeMenu'),
    icon: <Delete16Regular />,
    shortcut: 'Del',
    danger: true,
    run: () => void removeEntries(ids),
  });
  openMenu(x, y, items);
}

// ───────────── Navigation (sidebar column) ─────────────

function NavItem({
  scope,
  icon,
  label,
  count,
  extra,
}: {
  scope: LibraryScope;
  icon: ReactNode;
  label: string;
  count?: number;
  extra?: Partial<React.HTMLAttributes<HTMLButtonElement>> & { className?: string };
}) {
  const current = useLibraryView((v) => v.scope);
  const [drop, setDrop] = useState(false);
  // Projects dropped on a collection (or the inbox, favorites, archive) are sorted into it.
  const target =
    scope.kind === 'collection' ||
    scope.kind === 'inbox' ||
    scope.kind === 'favorites' ||
    scope.kind === 'archived';
  const { className, ...rest } = extra ?? {};
  return (
    <button
      type="button"
      className={cx(s.navItem, sameScope(current, scope) && s.navOn, drop && s.navDrop, className)}
      onClick={() => useLibraryView.setState({ scope, selected: [] })}
      onDragOver={(e) => {
        if (!target || !e.dataTransfer.types.includes(LIBRARY_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const id = e.dataTransfer.getData(LIBRARY_DRAG);
        if (!id || !target) return;
        e.preventDefault();
        const sel = useLibraryView.getState().selected;
        const ids = sel.includes(id) ? sel : [id];
        if (scope.kind === 'collection') setCollection(ids, scope.id);
        else if (scope.kind === 'inbox') setCollection(ids, null);
        else if (scope.kind === 'favorites') setFavorite(ids, true);
        else if (scope.kind === 'archived') setStatus(ids, 'archived');
      }}
      {...rest}
    >
      {icon}
      <span className={s.navLabel}>{label}</span>
      {count !== undefined && count > 0 && <span className={s.navCount}>{count}</span>}
    </button>
  );
}

function useDisks(paths: string[]): Map<string, { free: number; total: number }> {
  const [disks, setDisks] = useState(new Map<string, { free: number; total: number }>());
  const key = paths.join('|');
  useEffect(() => {
    let live = true;
    if (!key) return;
    void api.invoke('library:disk', key.split('|')).then((list) => {
      if (live) setDisks(new Map(list.map((d) => [d.path, d])));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return disks;
}

function FolderRow({ path, id, free, total }: { path: string; id: string; free?: number; total?: number }) {
  const tr = useT();
  const home = useApp((st) => st.home);
  const [drop, setDrop] = useState(false);
  const low = free !== undefined && total ? free / total < 0.1 : false;
  return (
    <button
      type="button"
      className={cx(s.navItem, s.folderItem, drop && s.navDrop)}
      title={path}
      onClick={() => void api.invoke('shell:open-path', path)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          {
            label: tr('projects.reveal'),
            icon: <FolderOpen16Regular />,
            run: () => void api.invoke('shell:open-path', path),
          },
          'separator',
          {
            label: tr('library.folderRemove'),
            icon: <Delete16Regular />,
            danger: true,
            run: () => void op({ op: 'folderRemove', id }),
          },
        ]);
      }}
      // A project dropped on a library folder: "Move…" with that destination.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(LIBRARY_DRAG)) return;
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const entryId = e.dataTransfer.getData(LIBRARY_DRAG);
        if (!entryId) return;
        e.preventDefault();
        moveDestination.set(entryId, path);
        startMove(entryId);
      }}
    >
      <HardDrive16Regular />
      <span className={s.folderPath}>
        <bdi>{shortPath(path, home)}</bdi>
      </span>
      <span />
      <span className={s.space}>
        {free !== undefined && total ? (
          <>
            <span className={cx(s.spaceBar, low && s.spaceLow)}>
              <span style={{ width: `${Math.round((1 - free / total) * 100)}%` }} />
            </span>
            {tr('library.free', bytes(free))}
          </>
        ) : (
          tr('library.folderOffline')
        )}
      </span>
    </button>
  );
}

/** Where a card dropped on a library folder should go (read by the Move dialog). */
export const moveDestination = new Map<string, string>();

export function LibraryNav() {
  const tr = useT();
  const lib = useLibrary();
  const [dropAt, setDropAt] = useState<number | null>(null);
  const disks = useDisks(lib.folders.map((f) => f.path));
  const count = (scope: LibraryScope) => lib.entries.filter((e) => inScope(e, scope)).length;

  return (
    <aside className={s.nav} aria-label={tr('library.title')}>
      <div className={s.navHeader}>
        <span className={s.navTitle}>{tr('library.title')}</span>
        <IconButton
          label={tr('library.scan')}
          size="sm"
          onClick={() => useLibraryView.setState({ importOpen: true })}
        >
          <FolderSearch16Regular />
        </IconButton>
      </div>
      <NavItem
        scope={{ kind: 'all' }}
        icon={<Grid16Regular />}
        label={tr('library.all')}
        count={count({ kind: 'all' })}
      />
      <NavItem
        scope={{ kind: 'favorites' }}
        icon={<Star16Regular />}
        label={tr('library.favorites')}
        count={count({ kind: 'favorites' })}
      />
      <NavItem scope={{ kind: 'recent' }} icon={<History16Regular />} label={tr('library.recent')} />
      <NavItem
        scope={{ kind: 'inbox' }}
        icon={<MailInbox16Regular />}
        label={tr('library.inbox')}
        count={count({ kind: 'inbox' })}
      />

      <div className={s.navSection}>
        <span>{tr('library.collections')}</span>
        <IconButton label={tr('library.newCollection')} size="sm" onClick={() => void newCollectionFlow()}>
          <Add16Regular />
        </IconButton>
      </div>
      <div
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(COLLECTION_DRAG);
          if (id && dropAt !== null) {
            const from = lib.collections.findIndex((c) => c.id === id);
            void op({ op: 'collectionMove', id, toIndex: from < dropAt ? dropAt - 1 : dropAt });
          }
          setDropAt(null);
        }}
      >
        {lib.collections.map((c, i) => (
          <NavItem
            key={c.id}
            scope={{ kind: 'collection', id: c.id }}
            icon={<span className={s.dot} style={c.color ? { background: c.color } : undefined} />}
            label={c.name}
            count={count({ kind: 'collection', id: c.id })}
            extra={{
              className: dropAt === i ? s.navDropBefore : undefined,
              draggable: true,
              onDragStart: (e) => {
                e.dataTransfer.setData(COLLECTION_DRAG, c.id);
                e.dataTransfer.effectAllowed = 'move';
              },
              onDragOverCapture: (e) => {
                if (!e.dataTransfer.types.includes(COLLECTION_DRAG)) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
              },
              onContextMenu: (e) => {
                e.preventDefault();
                collectionMenu(c, e.clientX, e.clientY);
              },
              onDoubleClick: () => void renameCollectionFlow(c.id),
            }}
          />
        ))}
        {lib.collections.length === 0 && <div className={s.navEmpty}>{tr('library.noCollections')}</div>}
      </div>
      <NavItem
        scope={{ kind: 'archived' }}
        icon={<Archive16Regular />}
        label={tr('library.archived')}
        count={count({ kind: 'archived' })}
      />

      <div className={s.navSection}>
        <span>{tr('library.folders')}</span>
        <IconButton label={tr('library.folderAdd')} size="sm" onClick={() => void addLibraryFolderFlow()}>
          <Add16Regular />
        </IconButton>
      </div>
      {lib.folders.map((f) => (
        <FolderRow
          key={f.id}
          id={f.id}
          path={f.path}
          free={disks.get(f.path)?.free}
          total={disks.get(f.path)?.total}
        />
      ))}
      {lib.folders.length === 0 && <div className={s.navEmpty}>{tr('library.noFolders')}</div>}
    </aside>
  );
}

// ───────────── Sheet ─────────────

const SORTS: LibrarySort[] = ['recent', 'name', 'modified', 'added'];
const SORT_LABEL = {
  recent: 'library.sortRecent',
  name: 'library.sortName',
  modified: 'library.sortModified',
  added: 'library.sortAdded',
} as const;

function scopeTitle(scope: LibraryScope, collections: Collection[]): string {
  switch (scope.kind) {
    case 'all':
      return t('library.all');
    case 'favorites':
      return t('library.favorites');
    case 'recent':
      return t('library.recent');
    case 'inbox':
      return t('library.inbox');
    case 'archived':
      return t('library.archived');
    case 'collection':
      return collections.find((c) => c.id === scope.id)?.name ?? t('library.all');
  }
}

/** Everything the toolbar filters by, as menus with check marks. */
function filterMenu(kind: 'stack' | 'tags', options: string[], x: number, y: number): void {
  const v = useLibraryView.getState();
  const current = kind === 'stack' ? v.stack : v.tags;
  const toggle = (item: string) => {
    const has = current.some((c) => c.toLowerCase() === item.toLowerCase());
    const next = has ? current.filter((c) => c.toLowerCase() !== item.toLowerCase()) : [...current, item];
    useLibraryView.setState(kind === 'stack' ? { stack: next } : { tags: next });
  };
  openMenu(
    x,
    y,
    options.length === 0
      ? [{ label: t(kind === 'stack' ? 'library.noStack' : 'library.noTags'), disabled: true }]
      : options.slice(0, 40).map((o) => ({
          label: o,
          checked: current.some((c) => c.toLowerCase() === o.toLowerCase()),
          run: () => toggle(o),
        })),
  );
}

export function LibraryView() {
  const tr = useT();
  const lib = useLibrary();
  const v = useLibraryView();
  const search = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

  const shown = useMemo(
    () =>
      sortEntries(
        filterEntries(lib.entries, { scope: v.scope, query: v.query, tags: v.tags, stack: v.stack }),
        v.sort,
        v.scope,
      ),
    [lib.entries, v.scope, v.query, v.tags, v.stack, v.sort],
  );
  const options = useMemo(
    () => facets(lib.entries.filter((e) => inScope(e, v.scope))),
    [lib.entries, v.scope],
  );
  const describing = lib.entries.filter((e) => e.job.state === 'queued' || e.job.state === 'running').length;
  const needsAuth = lib.entries.some((e) => e.job.state === 'auth');
  const noClaude = lib.entries.some((e) => e.job.state === 'unavailable');

  // "All" is grouped by collection (Inbox first); the other views are one list.
  const groups = useMemo(() => {
    if (v.scope.kind !== 'all')
      return [{ key: 'one', title: null as string | null, color: null as string | null, items: shown }];
    const out = [
      {
        key: 'inbox',
        title: tr('library.inbox'),
        color: null,
        items: shown.filter((e) => e.collectionId === null),
      },
      ...lib.collections.map((c) => ({
        key: c.id,
        title: c.name,
        color: c.color,
        items: shown.filter((e) => e.collectionId === c.id),
      })),
    ];
    return out.filter((g) => g.items.length > 0);
  }, [shown, lib.collections, v.scope.kind, tr]);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((e) => e.id)), [groups]);

  // '/' focuses the search; Escape clears it, then the selection, then leaves the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      if (
        st.dialog ||
        st.paletteOpen ||
        st.settingsOpen ||
        useLibraryView.getState().moving ||
        useLibraryView.getState().importOpen
      )
        return;
      // A menu or dialog handled the key already (its own Escape).
      if (e.defaultPrevented) return;
      const inInput = (e.target as HTMLElement | null)?.closest('input, textarea, select');
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'Escape') {
        const cur = useLibraryView.getState();
        if (cur.query) useLibraryView.setState({ query: '' });
        else if (cur.selected.length) useLibraryView.setState({ selected: [] });
        else if (useWorkspace.getState().projects.length > 0) useLibraryView.setState({ open: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const anchor = useRef<string | null>(null);
  const onSelect = useCallback(
    (id: string, ev: React.MouseEvent | React.KeyboardEvent) => {
      const cur = useLibraryView.getState().selected;
      if (ev.ctrlKey || ev.metaKey) {
        useLibraryView.setState({ selected: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
        anchor.current = id;
      } else if (ev.shiftKey && anchor.current) {
        const a = order.indexOf(anchor.current);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0)
          useLibraryView.setState({ selected: order.slice(Math.min(a, b), Math.max(a, b) + 1) });
      } else {
        useLibraryView.setState({ selected: [id] });
        anchor.current = id;
      }
    },
    [order],
  );
  const onOpen = useCallback((id: string) => {
    const e = entryById(id);
    if (e?.missing) void locateFlow(e);
    else void openFromLibrary(id);
  }, []);
  const onMenu = useCallback((id: string, x: number, y: number) => {
    const sel = useLibraryView.getState().selected;
    entryMenu(sel.includes(id) ? sel : [id], x, y);
  }, []);
  const onKey = useCallback(
    (id: string, ev: React.KeyboardEvent) => {
      const sel = useLibraryView.getState().selected;
      const ids = sel.includes(id) ? sel : [id];
      const e = entryById(id);
      if (!e) return;
      if (ev.key === 'Enter') onOpen(id);
      else if (ev.key === 'F2') void renameEntryFlow(e);
      else if (ev.key === 'Delete') void removeEntries(ids);
      else if (ev.key === ' ') onSelect(id, ev);
      else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        entryMenu(ids, r.left + 24, r.top + 24);
      } else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
        const els = [...document.querySelectorAll<HTMLElement>('[data-entry]')];
        const i = els.findIndex((x) => x.dataset.entry === id);
        if (i < 0) return;
        // Cards per row: how many share the first card's top.
        const perRow =
          v.layout === 'grid' ? Math.max(1, els.filter((x) => x.offsetTop === els[0]!.offsetTop).length) : 1;
        const step = {
          ArrowRight: 1,
          ArrowLeft: -1,
          ArrowDown: perRow,
          ArrowUp: -perRow,
          Home: -i,
          End: els.length - 1 - i,
        }[ev.key]!;
        const next = els[Math.max(0, Math.min(els.length - 1, i + step))];
        if (next) {
          ev.preventDefault();
          next.focus();
          if (!ev.shiftKey) useLibraryView.setState({ selected: [next.dataset.entry!] });
        }
      } else return;
      if (ev.key !== ' ') ev.stopPropagation();
    },
    [onOpen, onSelect, v.layout],
  );
  const onFilterStack = useCallback((item: string) => {
    const cur = useLibraryView.getState().stack;
    if (!cur.some((c) => c.toLowerCase() === item.toLowerCase()))
      useLibraryView.setState({ stack: [...cur, item] });
  }, []);

  const selected = v.selected.filter((id) => lib.entries.some((e) => e.id === id));
  const filtered = v.query !== '' || v.tags.length > 0 || v.stack.length > 0;

  return (
    <main
      className={cx(s.sheet, dropping && s.dropping)}
      aria-label={tr('library.title')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        // Folders dropped here join the library (in the collection on screen) without opening.
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
        const collectionId = v.scope.kind === 'collection' ? v.scope.id : null;
        void api.invoke('library:add', paths, collectionId);
      }}
    >
      <div className={s.toolbar}>
        <label className={s.searchBox}>
          <Search16Regular />
          <input
            ref={search}
            value={v.query}
            placeholder={tr('library.search')}
            spellCheck={false}
            aria-label={tr('library.search')}
            onChange={(e) => useLibraryView.setState({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                document.querySelector<HTMLElement>('[data-entry]')?.focus();
              } else if (e.key === 'Enter' && shown.length === 1) onOpen(shown[0]!.id);
            }}
          />
          {v.query && (
            <IconButton
              label={tr('common.clear')}
              size="sm"
              onClick={() => useLibraryView.setState({ query: '' })}
            >
              <Dismiss12Regular />
            </IconButton>
          )}
        </label>
        <Button
          variant="subtle"
          className={cx(v.stack.length > 0 && s.filterOn)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            filterMenu('stack', options.stack, r.left, r.bottom + 4);
          }}
        >
          <Filter16Regular />
          {tr('library.stack')}
          {v.stack.length > 0 && ` ${v.stack.length}`}
        </Button>
        <Button
          variant="subtle"
          className={cx(v.tags.length > 0 && s.filterOn)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            filterMenu('tags', options.tags, r.left, r.bottom + 4);
          }}
        >
          <Tag16Regular />
          {tr('library.tagsFilter')}
          {v.tags.length > 0 && ` ${v.tags.length}`}
        </Button>
        <Button
          variant="subtle"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(
              r.left,
              r.bottom + 4,
              SORTS.map((x) => ({
                label: tr(SORT_LABEL[x]),
                checked: v.sort === x,
                run: () => useLibraryView.setState({ sort: x }),
              })),
            );
          }}
        >
          <ArrowSort16Regular />
          {tr(SORT_LABEL[v.sort])}
        </Button>
        <IconButton
          label={v.layout === 'grid' ? tr('library.asList') : tr('library.asGrid')}
          onClick={() => useLibraryView.setState({ layout: v.layout === 'grid' ? 'list' : 'grid' })}
        >
          {v.layout === 'grid' ? <TextBulletList16Regular /> : <Grid16Regular />}
        </IconButton>
        <span className={s.toolbarSpacer} />
        <Button onClick={() => useLibraryView.setState({ importOpen: true })}>
          <FolderSearch16Regular />
          {tr('library.scan')}
        </Button>
        <Button variant="primary" onClick={() => void pickAndAddProject()}>
          <FolderAdd16Regular />
          {tr('projects.add')}
        </Button>
      </div>

      {filtered && (
        <div className={s.chipsActive}>
          {[...v.stack.map((x) => ['stack', x] as const), ...v.tags.map((x) => ['tags', x] as const)].map(
            ([kind, x]) => (
              <button
                key={kind + x}
                type="button"
                className={s.activeChip}
                onClick={() =>
                  useLibraryView.setState(
                    kind === 'stack'
                      ? { stack: v.stack.filter((y) => y !== x) }
                      : { tags: v.tags.filter((y) => y !== x) },
                  )
                }
              >
                {kind === 'tags' ? '#' : ''}
                {x}
                <Dismiss12Regular />
              </button>
            ),
          )}
        </div>
      )}

      <div className={s.heading}>
        <h1 className={s.headingTitle}>{scopeTitle(v.scope, lib.collections)}</h1>
        <span className={s.headingCount}>{tr('library.count', shown.length)}</span>
        {describing > 0 && (
          <span className={s.headingNote}>
            <Sparkle16Regular fontSize={14} />
            {tr('library.describingCount', describing)}
          </span>
        )}
        {describing === 0 && needsAuth && <span className={s.headingNote}>{tr('library.needsLogin')}</span>}
        {describing === 0 && !needsAuth && noClaude && (
          <span className={s.headingNote}>{tr('library.needsClaude')}</span>
        )}
      </div>

      {selected.length > 1 && (
        <div className={s.selection}>
          <span className={s.selectionCount}>{tr('library.selected', selected.length)}</span>
          <Button variant="subtle" onClick={(e) => entryMenu(selected, e.clientX, e.clientY)}>
            {tr('library.actions')}
          </Button>
          <Button variant="subtle" onClick={() => void editTagsFlow(selected)}>
            <Tag16Regular />
            {tr('library.tags')}
          </Button>
          <Button variant="subtle" onClick={() => describeAgain(selected)}>
            <ArrowSync16Regular />
            {tr('library.describeAgain')}
          </Button>
          <span className={s.toolbarSpacer} />
          <IconButton
            label={tr('library.clearSelection')}
            size="sm"
            onClick={() => useLibraryView.setState({ selected: [] })}
          >
            <Dismiss12Regular />
          </IconButton>
        </div>
      )}

      {shown.length === 0 ? (
        <Empty filtered={filtered} total={lib.entries.length} />
      ) : (
        <div
          className={s.scroll}
          role="listbox"
          aria-multiselectable="true"
          aria-label={scopeTitle(v.scope, lib.collections)}
          onClick={(e) => e.target === e.currentTarget && useLibraryView.setState({ selected: [] })}
        >
          {groups.map((g) => (
            <section key={g.key} className={s.group}>
              {g.title && (
                <h2 className={s.groupTitle}>
                  <span className={s.dot} style={g.color ? { background: g.color } : undefined} />
                  {g.title}
                  <span className={s.groupCount}>{g.items.length}</span>
                </h2>
              )}
              <div className={v.layout === 'grid' ? s.grid : s.list}>
                {g.items.map((e) => (
                  <ProjectCard
                    key={e.id}
                    e={e}
                    layout={v.layout}
                    selected={selected.includes(e.id)}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onMenu={onMenu}
                    onKey={onKey}
                    onFilterStack={onFilterStack}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function Empty({ filtered, total }: { filtered: boolean; total: number }) {
  const tr = useT();
  const home = useApp((st) => st.home);
  if (filtered)
    return (
      <div className={s.empty}>
        <div className={s.emptyCard}>
          <p className={s.emptyText}>{tr('library.noMatches')}</p>
          <Button onClick={() => useLibraryView.setState({ query: '', tags: [], stack: [] })}>
            {tr('library.clearFilters')}
          </Button>
        </div>
      </div>
    );
  if (total > 0)
    return (
      <div className={s.empty}>
        <div className={s.emptyCard}>
          <p className={s.emptyText}>{tr('library.emptyScope')}</p>
        </div>
      </div>
    );
  const desktop = home ? joinPath(home, 'Desktop') : '';
  return (
    <div className={s.empty}>
      <div className={s.emptyCard}>
        <h1 className={s.emptyTitle}>{tr('library.emptyTitle')}</h1>
        <p className={s.emptyText}>{tr('library.emptyBody')}</p>
        <div className={s.emptyActions}>
          {desktop && (
            <Button
              variant="primary"
              onClick={() => useLibraryView.setState({ importOpen: true, scanDir: desktop })}
            >
              <FolderSearch16Regular />
              {tr('library.scanDesktop')}
            </Button>
          )}
          <Button onClick={() => void pickAndAddProject()}>
            <FolderAdd16Regular />
            {tr('projects.add')}
          </Button>
        </div>
        <span className={s.muted}>{tr('projects.empty.drop')}</span>
      </div>
    </div>
  );
}
