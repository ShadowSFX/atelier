import { describe, expect, it } from 'vitest';
import {
  closeColumn,
  dropTerminal,
  normalizeLayout,
  parseWorkspace,
  pathIdentity,
  removeTerminalFromLayout,
  resizeColumns,
  showTerminal,
  splitRight,
  type ProjectLayout,
} from '@shared/workspace';

const ids = (l: ProjectLayout) => l.columns.map((c) => c.terminalId);
const terms = (...names: string[]) => names.map((id) => ({ id }));
const layout = (...names: string[]): ProjectLayout => ({
  columns: names.map((terminalId) => ({ terminalId, weight: 1 / names.length })),
  active: 0,
});

describe('layout', () => {
  it('normalizes: drops unknown and duplicate columns, caps at 3, fixes weights', () => {
    const l = normalizeLayout(
      {
        columns: [
          { terminalId: 'a', weight: 2 },
          { terminalId: 'x', weight: 1 },
          { terminalId: 'a', weight: 1 },
          { terminalId: 'b', weight: -1 },
          { terminalId: 'c', weight: 1 },
          { terminalId: 'd', weight: 1 },
        ],
        active: 9,
      },
      terms('a', 'b', 'c', 'd'),
    );
    expect(ids(l)).toEqual(['a', 'b', 'c']);
    expect(l.columns.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
    expect(l.active).toBe(2);
  });

  it('shows the first terminal when a project has terminals but no columns', () => {
    expect(ids(normalizeLayout({ columns: [], active: 0 }, terms('a', 'b')))).toEqual(['a']);
  });

  it('showTerminal focuses a visible terminal or replaces the active column', () => {
    const l = { ...layout('a', 'b'), active: 1 };
    expect(showTerminal(l, 'a').active).toBe(0);
    expect(ids(showTerminal(l, 'c'))).toEqual(['a', 'c']);
    expect(ids(showTerminal({ columns: [], active: 0 }, 'c'))).toEqual(['c']);
  });

  it('splits up to three columns and no more', () => {
    let l = layout('a');
    l = splitRight(l, 'b');
    expect(ids(l)).toEqual(['a', 'b']);
    expect(l.active).toBe(1);
    l = splitRight(l, 'c');
    expect(ids(l)).toEqual(['a', 'b', 'c']);
    expect(splitRight(l, 'd')).toBe(l);
  });

  it('drops on the left, right and center of a column', () => {
    expect(ids(dropTerminal(layout('a', 'b'), 'c', 0, 'left'))).toEqual(['c', 'a', 'b']);
    expect(ids(dropTerminal(layout('a', 'b'), 'c', 0, 'right'))).toEqual(['a', 'c', 'b']);
    expect(ids(dropTerminal(layout('a', 'b'), 'c', 1, 'center'))).toEqual(['a', 'c']);
  });

  it('moves a visible terminal instead of duplicating it', () => {
    expect(ids(dropTerminal(layout('a', 'b', 'c'), 'c', 0, 'left'))).toEqual(['c', 'a', 'b']);
    // Center on another column swaps them.
    expect(ids(dropTerminal(layout('a', 'b'), 'a', 1, 'center'))).toEqual(['b', 'a']);
    // Dropping a column's terminal on its own edge changes nothing.
    const l = layout('a', 'b');
    expect(dropTerminal(l, 'a', 0, 'right')).toBe(l);
  });

  it('keeps weights summing to 1 after splits and moves', () => {
    const l = dropTerminal(dropTerminal(layout('a'), 'b', 0, 'right'), 'a', 1, 'right');
    expect(l.columns.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
  });

  it('closes columns giving their width to the neighbor, never the last one', () => {
    const l = closeColumn({ ...layout('a', 'b', 'c'), active: 2 }, 0);
    expect(ids(l)).toEqual(['b', 'c']);
    expect(l.columns.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
    expect(l.active).toBe(1);
    const single = layout('a');
    expect(closeColumn(single, 0)).toBe(single);
  });

  it('replaces a removed terminal with a hidden one, or closes its column', () => {
    expect(ids(removeTerminalFromLayout(layout('a', 'b'), 'a', terms('b', 'c')))).toEqual(['c', 'b']);
    expect(ids(removeTerminalFromLayout(layout('a', 'b'), 'a', terms('b')))).toEqual(['b']);
    expect(ids(removeTerminalFromLayout(layout('a'), 'a', []))).toEqual([]);
  });

  it('resizes within the minimum width', () => {
    const l = resizeColumns(layout('a', 'b'), 0, 0.9);
    expect(l.columns[0]!.weight).toBeCloseTo(0.85);
    expect(l.columns[1]!.weight).toBeCloseTo(0.15);
  });
});

describe('workspace loading', () => {
  it('survives garbage', () => {
    expect(parseWorkspace(undefined)).toEqual({ version: 1, projects: [], activeProjectId: null });
    expect(parseWorkspace({ projects: 'nope' }).projects).toEqual([]);
  });

  it('drops invalid projects and terminals, keeps the rest', () => {
    const ws = parseWorkspace({
      projects: [
        {
          id: 'p1',
          name: '',
          path: 'C:\\work\\api',
          color: '#22a699',
          terminals: [{ id: 't1', name: 'api', profileId: 'pwsh' }, { bad: true }],
          layout: { columns: [{ terminalId: 't1', weight: 1 }] },
        },
        { id: 'p2', path: '' },
        { id: 'p3', path: 'c:/work/api/' }, // same directory as p1
        { id: 'p4', path: '/home/me/web', color: 'red', terminals: [{ id: 't1', name: 'dup id' }] },
      ],
      activeProjectId: 'gone',
    });
    expect(ws.projects.map((p) => p.id)).toEqual(['p1', 'p4']);
    expect(ws.projects[0]!.name).toBe('api');
    expect(ws.projects[0]!.color).toBe('#22A699');
    expect(ws.projects[0]!.terminals.map((t) => t.id)).toEqual(['t1']);
    expect(ws.projects[1]!.color).toBeNull();
    expect(ws.projects[1]!.terminals).toEqual([]);
    expect(ws.activeProjectId).toBe('p1');
  });

  it('identifies Windows directories case-insensitively', () => {
    expect(pathIdentity('C:\\Work\\API\\')).toBe(pathIdentity('c:/work/api'));
    expect(pathIdentity('/home/Me')).not.toBe(pathIdentity('/home/me'));
  });
});
