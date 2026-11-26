import { z } from 'zod';
import { normalizeColor } from './colors';
import { MAX_COLUMNS, MIN_COLUMN_WEIGHT } from './constants';

/** Persisted workspace: projects (directories), their terminals and the column layout of each project. */

export interface TerminalSpec {
  id: string;
  name: string;
  color: string | null;
  profileId: string;
  /** Last working directory reported by the shell (OSC 7); the next start opens here. */
  lastCwd: string | null;
  /** The user named it by hand: Claude's atelier_set_title leaves the name alone. */
  nameLocked?: boolean;
  /** The Claude Code session of this terminal (resumed when the terminal starts, if it was running). */
  claude?: ClaudeSessionRef;
}

/** A terminal's Claude session, persisted so it comes back after a restart or a power cut. */
export interface ClaudeSessionRef {
  /** Claude Code's session id (reported by its hooks); null until the session reports it. */
  sessionId: string | null;
  /** Started with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 (a Code Mode session resumes as one only with it). */
  codeMode: boolean;
  /** A session was running when the terminal was last saved: starting the terminal resumes it. */
  active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code session ids are UUIDs; nothing else is ever typed into a shell as one. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export interface PaneColumn {
  terminalId: string;
  /** Relative width; the columns' weights are normalized to sum 1. */
  weight: number;
}

export interface ProjectLayout {
  columns: PaneColumn[];
  /** Index of the focused column. */
  active: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string | null;
  terminals: TerminalSpec[];
  layout: ProjectLayout;
}

export interface Workspace {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
}

export const EMPTY_WORKSPACE: Workspace = { version: 1, projects: [], activeProjectId: null };

// ───────────── Tolerant loading ─────────────
// Invalid entries are dropped instead of failing the whole file (a corrupt workspace must never lose every project).

const Id = z.string().min(1).max(64);
const RawTerminal = z.object({
  id: Id,
  name: z.string().catch('Terminal'),
  color: z.unknown().optional().transform(normalizeColor),
  profileId: z.string().catch(''),
  lastCwd: z.string().nullable().catch(null),
  nameLocked: z.boolean().optional().catch(undefined),
  claude: z
    .object({
      sessionId: z.unknown().transform((v) => (isSessionId(v) ? v : null)),
      codeMode: z.boolean().catch(false),
      active: z.boolean().catch(false),
    })
    .optional()
    .catch(undefined),
});
const RawProject = z.object({
  id: Id,
  name: z.string().catch(''),
  path: z.string().min(1),
  color: z.unknown().optional().transform(normalizeColor),
  terminals: z.array(z.unknown()).catch([]),
  layout: z
    .object({ columns: z.array(z.unknown()).catch([]), active: z.number().catch(0) })
    .catch({ columns: [], active: 0 }),
});
const RawColumn = z.object({ terminalId: Id, weight: z.number().positive().catch(1) });

export function parseWorkspace(raw: unknown): Workspace {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const projects: Project[] = [];
  const seenProjects = new Set<string>();
  const seenPaths = new Set<string>();
  const seenTerminals = new Set<string>();

  for (const p of Array.isArray(obj.projects) ? obj.projects : []) {
    const r = RawProject.safeParse(p);
    if (!r.success) continue;
    const pathKey = pathIdentity(r.data.path);
    if (seenProjects.has(r.data.id) || seenPaths.has(pathKey)) continue;
    seenProjects.add(r.data.id);
    seenPaths.add(pathKey);

    const terminals: TerminalSpec[] = [];
    for (const t of r.data.terminals) {
      const tr = RawTerminal.safeParse(t);
      if (!tr.success || seenTerminals.has(tr.data.id)) continue;
      seenTerminals.add(tr.data.id);
      terminals.push(tr.data);
    }
    const columns = r.data.layout.columns.flatMap((c) => {
      const cr = RawColumn.safeParse(c);
      return cr.success ? [cr.data] : [];
    });
    projects.push({
      id: r.data.id,
      name: r.data.name || baseName(r.data.path),
      path: r.data.path,
      color: r.data.color,
      terminals,
      layout: normalizeLayout({ columns, active: r.data.layout.active }, terminals),
    });
  }
  const active = typeof obj.activeProjectId === 'string' ? obj.activeProjectId : null;
  return {
    version: 1,
    projects,
    activeProjectId: projects.some((p) => p.id === active) ? active : (projects[0]?.id ?? null),
  };
}

/** Case-insensitive on Windows, trailing separators ignored: two projects can't share a directory. */
export function pathIdentity(path: string, windows = isWindowsPath(path)): string {
  let p = path.replace(/[\\/]+$/, '');
  if (windows) p = p.replace(/\//g, '\\').toLowerCase();
  return p || path;
}

function isWindowsPath(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// ───────────── Layout (≤ MAX_COLUMNS columns) ─────────────

/** Drops columns of unknown or repeated terminals, caps the count, normalizes weights and the active index. */
export function normalizeLayout(layout: ProjectLayout, terminals: readonly { id: string }[]): ProjectLayout {
  const known = new Set(terminals.map((t) => t.id));
  const seen = new Set<string>();
  const columns = layout.columns
    .filter((c) => known.has(c.terminalId) && !seen.has(c.terminalId) && seen.add(c.terminalId))
    .slice(0, MAX_COLUMNS)
    .map((c) => ({
      terminalId: c.terminalId,
      weight: Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 1,
    }));
  if (columns.length === 0 && terminals.length > 0) columns.push({ terminalId: terminals[0]!.id, weight: 1 });
  const total = columns.reduce((a, c) => a + c.weight, 0) || 1;
  for (const c of columns) c.weight = c.weight / total;
  const active = Math.min(Math.max(0, Math.round(layout.active) || 0), Math.max(0, columns.length - 1));
  return { columns, active };
}

/**
 * Shows a terminal: focuses its column if it is already visible, otherwise puts it in the active column
 * (or creates the first column).
 */
export function showTerminal(layout: ProjectLayout, terminalId: string): ProjectLayout {
  const at = layout.columns.findIndex((c) => c.terminalId === terminalId);
  if (at >= 0) return { ...layout, active: at };
  if (layout.columns.length === 0) return { columns: [{ terminalId, weight: 1 }], active: 0 };
  const columns = layout.columns.map((c, i) => (i === layout.active ? { ...c, terminalId } : c));
  return { columns, active: layout.active };
}

export type DropSide = 'left' | 'center' | 'right';

/**
 * Drops a terminal on a column: center replaces that column's terminal, left/right inserts a new column
 * (taking half of the target's width). A terminal already visible elsewhere moves (its old column closes).
 * Returns the layout unchanged when a split would exceed MAX_COLUMNS.
 */
export function dropTerminal(
  layout: ProjectLayout,
  terminalId: string,
  target: number,
  side: DropSide,
): ProjectLayout {
  if (layout.columns.length === 0) return { columns: [{ terminalId, weight: 1 }], active: 0 };
  const from = layout.columns.findIndex((c) => c.terminalId === terminalId);
  const targetCol = layout.columns[target];
  if (!targetCol) return layout;

  if (side === 'center') {
    if (from === target) return { ...layout, active: target };
    let columns = layout.columns.map((c, i) => (i === target ? { ...c, terminalId } : c));
    const active = target;
    if (from >= 0) {
      // The terminal leaves its old column: that column takes the replaced terminal (a swap).
      columns = columns.map((c, i) => (i === from ? { ...c, terminalId: targetCol.terminalId } : c));
    }
    return { columns, active };
  }

  // Split: work on the layout without the moving terminal first.
  const columns = layout.columns.map((c) => ({ ...c }));
  let idx = target;
  if (from >= 0) {
    if (from === target) return layout; // splitting a column with its own terminal does nothing
    const removed = columns.splice(from, 1)[0]!;
    const neighbor = columns[Math.max(0, from - 1)]!;
    neighbor.weight += removed.weight;
    if (from < target) idx -= 1;
  }
  if (columns.length >= MAX_COLUMNS) return layout;
  const t = columns[idx]!;
  const half = t.weight / 2;
  t.weight = half;
  const insertAt = side === 'left' ? idx : idx + 1;
  columns.splice(insertAt, 0, { terminalId, weight: half });
  return { columns, active: insertAt };
}

/** Opens a terminal in a new column to the right of the active one (no-op at MAX_COLUMNS). */
export function splitRight(layout: ProjectLayout, terminalId: string): ProjectLayout {
  if (layout.columns.length === 0) return { columns: [{ terminalId, weight: 1 }], active: 0 };
  return dropTerminal(layout, terminalId, layout.active, 'right');
}

/** Closes a column (the terminal keeps running; it is only hidden). Its width goes to its neighbor. */
export function closeColumn(layout: ProjectLayout, index: number): ProjectLayout {
  if (!layout.columns[index] || layout.columns.length <= 1) return layout;
  const columns = layout.columns.map((c) => ({ ...c }));
  const [removed] = columns.splice(index, 1);
  columns[Math.max(0, index - 1)]!.weight += removed!.weight;
  return {
    columns,
    active: Math.min(
      layout.active >= index ? Math.max(0, layout.active - 1) : layout.active,
      columns.length - 1,
    ),
  };
}

/** A terminal was deleted: its column shows another terminal that isn't visible, or closes. */
export function removeTerminalFromLayout(
  layout: ProjectLayout,
  terminalId: string,
  remaining: readonly { id: string }[],
): ProjectLayout {
  const at = layout.columns.findIndex((c) => c.terminalId === terminalId);
  if (at < 0) return layout;
  const visible = new Set(layout.columns.map((c) => c.terminalId));
  const replacement = remaining.find((t) => t.id !== terminalId && !visible.has(t.id));
  if (replacement) {
    return {
      ...layout,
      columns: layout.columns.map((c, i) => (i === at ? { ...c, terminalId: replacement.id } : c)),
    };
  }
  if (layout.columns.length > 1) return closeColumn(layout, at);
  return { columns: [], active: 0 };
}

/** Splitter drag between column i and i+1: `delta` is a fraction of the total width. */
export function resizeColumns(layout: ProjectLayout, i: number, delta: number): ProjectLayout {
  const a = layout.columns[i];
  const b = layout.columns[i + 1];
  if (!a || !b) return layout;
  const sum = a.weight + b.weight;
  const wa = Math.min(sum - MIN_COLUMN_WEIGHT, Math.max(MIN_COLUMN_WEIGHT, a.weight + delta));
  const columns = layout.columns.map((c, k) =>
    k === i ? { ...c, weight: wa } : k === i + 1 ? { ...c, weight: sum - wa } : c,
  );
  return { ...layout, columns };
}
