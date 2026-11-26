import { describe, expect, it } from 'vitest';
import {
  applyOp,
  EMPTY_LIBRARY,
  entryDescription,
  facets,
  filterEntries,
  newEntry,
  normalizeTags,
  parseLibrary,
  parseOp,
  rebaseLibrary,
  rebasePath,
  rebaseWorkspace,
  sortEntries,
  type Library,
  type LibraryEntry,
} from '@shared/library';

const W = 'C:\\Users\\me\\Desktop';
const entry = (id: string, path: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  ...newEntry(id, path, 1000),
  ...over,
});
const lib = (entries: LibraryEntry[], over: Partial<Library> = {}): Library => ({
  ...EMPTY_LIBRARY,
  entries,
  ...over,
});

describe('parseLibrary', () => {
  it('drops invalid and repeated entries, never the whole file', () => {
    const parsed = parseLibrary({
      entries: [
        { id: 'p1', path: W + '\\apex', name: '' },
        { id: 'p1', path: W + '\\other' }, // repeated id
        { id: 'p2', path: W.toLowerCase() + '\\APEX\\' }, // same folder (Windows: case, trailing separator)
        { id: 'p3' }, // no path
        'junk',
        { id: 'p4', path: W + '\\gaspel', tags: ['a', 'A', ' b ', 3], collectionId: 'gone' },
      ],
      collections: [
        { id: 'c1', name: 'Work' },
        { id: 'c1', name: 'Again' },
      ],
    });
    expect(parsed.entries.map((e) => e.id)).toEqual(['p1', 'p4']);
    expect(parsed.entries[0]!.name).toBe('apex'); // empty name: the folder's
    expect(parsed.entries[1]!.tags).toEqual(['a', 'b']);
    expect(parsed.entries[1]!.collectionId).toBeNull(); // unknown collection: Inbox
    expect(parsed.collections).toHaveLength(1);
  });

  it('queues again a description that was running, and keeps valid remembered setups only', () => {
    const parsed = parseLibrary({
      entries: [
        {
          id: 'p1',
          path: W + '\\a',
          job: { state: 'running', attempts: 1 },
          remembered: {
            terminals: [{ id: 't1', name: 'x', profileId: 'pwsh', lastCwd: null }, { bad: true }],
            layout: {
              columns: [
                { terminalId: 't1', weight: 1 },
                { terminalId: 'nope', weight: 1 },
              ],
              active: 5,
            },
          },
        },
        // A terminal id already used by another remembered setup is dropped.
        {
          id: 'p2',
          path: W + '\\b',
          remembered: { terminals: [{ id: 't1', name: 'y', profileId: '', lastCwd: null }] },
        },
      ],
    });
    expect(parsed.entries[0]!.job.state).toBe('queued');
    expect(parsed.entries[0]!.remembered?.terminals.map((t) => t.id)).toEqual(['t1']);
    expect(parsed.entries[0]!.remembered?.layout).toEqual({
      columns: [{ terminalId: 't1', weight: 1 }],
      active: 0,
    });
    expect(parsed.entries[1]!.remembered).toBeNull();
  });

  it('reads garbage as an empty library', () => {
    expect(parseLibrary(null)).toEqual(EMPTY_LIBRARY);
    expect(parseLibrary('x')).toEqual(EMPTY_LIBRARY);
  });
});

describe('operations', () => {
  const base = lib([entry('p1', W + '\\a'), entry('p2', W + '\\b')], {
    collections: [{ id: 'c1', name: 'Work', color: null }],
  });

  it('renames, tags, favorites and sorts into collections', () => {
    let l = applyOp(base, { op: 'rename', id: 'p1', name: '  Apex  ' });
    l = applyOp(l, { op: 'tags', ids: ['p1', 'p2'], add: ['client', 'Client', '2024'] });
    l = applyOp(l, { op: 'tags', ids: ['p2'], remove: ['CLIENT'] });
    l = applyOp(l, { op: 'favorite', ids: ['p2'], value: true });
    l = applyOp(l, { op: 'collection', ids: ['p1'], collectionId: 'c1' });
    expect(l.entries[0]).toMatchObject({ name: 'Apex', tags: ['client', '2024'], collectionId: 'c1' });
    expect(l.entries[1]).toMatchObject({ tags: ['2024'], favorite: true });
  });

  it('ignores invalid changes', () => {
    expect(applyOp(base, { op: 'rename', id: 'p1', name: '   ' })).toBe(base);
    expect(applyOp(base, { op: 'collection', ids: ['p1'], collectionId: 'nope' })).toBe(base);
    expect(applyOp(base, { op: 'folderAdd', id: 'f1', path: 'D:\\Projects' }).folders).toHaveLength(1);
    const once = applyOp(base, { op: 'folderAdd', id: 'f1', path: 'D:\\Projects' });
    expect(applyOp(once, { op: 'folderAdd', id: 'f2', path: 'd:\\projects\\' })).toBe(once);
  });

  it('deleting a collection sends its projects back to the Inbox', () => {
    const l = applyOp(applyOp(base, { op: 'collection', ids: ['p1'], collectionId: 'c1' }), {
      op: 'collectionRemove',
      id: 'c1',
    });
    expect(l.collections).toHaveLength(0);
    expect(l.entries[0]!.collectionId).toBeNull();
  });

  it('a note wins over Claude, and clearing it brings Claude back', () => {
    let l = applyOp(
      lib([
        entry('p1', W + '\\a', {
          claude: { text: 'From Claude', stack: [], kind: 'app', model: 'opus', at: 1 },
        }),
      ]),
      { op: 'note', id: 'p1', note: ' Mine ' },
    );
    expect(entryDescription(l.entries[0]!)).toBe('Mine');
    l = applyOp(l, { op: 'note', id: 'p1', note: '' });
    expect(entryDescription(l.entries[0]!)).toBe('From Claude');
  });

  it('parseOp rejects shapes the renderer must never send', () => {
    expect(parseOp({ op: 'rename', id: 'p1', name: 'x' })).not.toBeNull();
    expect(parseOp({ op: 'rename', id: '', name: 'x' })).toBeNull();
    expect(parseOp({ op: 'drop-table' })).toBeNull();
    expect(
      parseOp({ op: 'remember', id: 'p1', remembered: { terminals: [{ id: '' }], layout: {} } }),
    ).toEqual({
      op: 'remember',
      id: 'p1',
      remembered: null, // no valid terminal left
    });
  });

  it('normalizes tags', () => {
    expect(normalizeTags(['  a  b ', 'A  B', '', 'c'])).toEqual(['a b', 'c']);
  });
});

describe('rebasing paths after a move', () => {
  it('replaces the prefix only for paths inside the old folder', () => {
    expect(rebasePath(W + '\\apex', W + '\\apex', 'D:\\Projects\\apex')).toBe('D:\\Projects\\apex');
    expect(rebasePath(W + '\\apex\\backend\\src', W + '\\APEX\\', 'D:\\P\\apex')).toBe(
      'D:\\P\\apex\\backend\\src',
    );
    expect(rebasePath(W + '\\apex-backend', W + '\\apex', 'D:\\P\\apex')).toBe(W + '\\apex-backend');
    expect(rebasePath('/home/me/a/b', '/home/me/a', '/srv/a')).toBe('/srv/a/b');
  });

  it('moves nested entries, remembered terminals and every open terminal inside', () => {
    const l = rebaseLibrary(
      lib([
        entry('p1', W + '\\apex'),
        entry('p2', W + '\\apex\\backend', {
          remembered: {
            terminals: [
              { id: 't9', name: 'x', color: null, profileId: '', lastCwd: W + '\\apex\\backend\\src' },
            ],
            layout: { columns: [], active: 0 },
          },
        }),
        entry('p3', W + '\\other'),
      ]),
      W + '\\apex',
      'D:\\P\\apex',
    );
    expect(l.entries.map((e) => e.path)).toEqual(['D:\\P\\apex', 'D:\\P\\apex\\backend', W + '\\other']);
    expect(l.entries[1]!.remembered!.terminals[0]!.lastCwd).toBe('D:\\P\\apex\\backend\\src');

    const ws = rebaseWorkspace(
      {
        projects: [
          {
            path: W + '\\apex',
            terminals: [{ id: 't1', name: 'a', color: null, profileId: '', lastCwd: null }],
          },
          // A terminal of another project that cd'ed into the moved folder follows it too.
          {
            path: W + '\\other',
            terminals: [{ id: 't2', name: 'b', color: null, profileId: '', lastCwd: W + '\\apex\\x' }],
          },
        ],
      },
      W + '\\apex',
      'D:\\P\\apex',
    );
    expect(ws.projects[0]!.path).toBe('D:\\P\\apex');
    expect(ws.projects[1]!.terminals[0]!.lastCwd).toBe('D:\\P\\apex\\x');
    expect(ws.projects[1]!.path).toBe(W + '\\other');
  });
});

describe('views', () => {
  const entries = [
    entry('a', W + '\\alpha', {
      lastOpenedAt: 5,
      tags: ['client'],
      local: {
        stack: ['TypeScript', 'Angular'],
        languages: [],
        kind: 'web',
        summary: 'Credit system',
        git: null,
        modifiedAt: 50,
        isCode: true,
        analyzedAt: 1,
      },
    }),
    entry('b', W + '\\beta', {
      favorite: true,
      addedAt: 9,
      local: {
        stack: ['Python'],
        languages: [],
        kind: 'tool',
        summary: null,
        git: { branch: 'main', worktree: false, lastCommitAt: 90 },
        modifiedAt: 10,
        isCode: true,
        analyzedAt: 1,
      },
    }),
    entry('c', W + '\\gamma', { status: 'archived' }),
  ];

  it('filters by scope, words, tags and stack (all of them)', () => {
    const f = (o: Partial<Parameters<typeof filterEntries>[1]>) =>
      filterEntries(entries, { scope: { kind: 'all' }, query: '', tags: [], stack: [], ...o }).map(
        (e) => e.id,
      );
    expect(f({})).toEqual(['a', 'b']); // archived only in the Archive
    expect(f({ scope: { kind: 'archived' } })).toEqual(['c']);
    expect(f({ scope: { kind: 'favorites' } })).toEqual(['b']);
    expect(f({ query: 'credit angular' })).toEqual(['a']);
    expect(f({ stack: ['python'] })).toEqual(['b']);
    expect(f({ tags: ['CLIENT'] })).toEqual(['a']);
    expect(f({ scope: { kind: 'recent' } })).toEqual(['a']);
  });

  it('sorts by name, recent use and last activity', () => {
    const ids = (s: Parameters<typeof sortEntries>[1]) =>
      sortEntries(entries.slice(0, 2), s).map((e) => e.id);
    expect(ids('name')).toEqual(['a', 'b']);
    expect(ids('recent')).toEqual(['b', 'a']); // b was added at 9, a opened at 5
    expect(ids('modified')).toEqual(['b', 'a']); // b's last commit (90) beats a's files (50)
    // Most used first, then alphabetical.
    expect(facets(entries).stack).toEqual(['Angular', 'Python', 'TypeScript']);
  });
});
