import type { ClaudeState } from './ipc';
import { isInsidePath } from './launchers';
import { pathIdentity } from './workspace';

/** Moving a project folder (library "Move…"): the plan shown before it starts, and its progress. */

/** Why a move can't start. */
export type MoveBlocker =
  | 'same'
  | 'source-missing'
  | 'dest-exists'
  | 'dest-inside-source'
  | 'source-protected'
  | 'unsupported-path'
  | 'invalid-name'
  | 'no-space'
  | 'dest-unreachable'
  | 'busy';

/** What the user should know before moving. */
export type MoveWarning = 'cross-volume' | 'venv' | 'cmake' | 'worktrees' | 'is-worktree';

export interface MoveTerminal {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  /** Something besides the shell runs in it (it will be stopped). */
  busy: boolean;
  foreground: string | null;
  claude: ClaudeState | null;
}

export interface MovePlan {
  id: string;
  entryId: string;
  source: string;
  destination: string;
  crossVolume: boolean;
  /** Bytes to copy (cross-volume only; null when not counted). */
  bytes: number | null;
  blockers: MoveBlocker[];
  warnings: MoveWarning[];
  /** Terminals that are stopped and started again in the new place. */
  terminals: MoveTerminal[];
  /** Other library projects inside the folder (they move with it). */
  nested: { id: string; name: string }[];
  /** Claude Code data folders (history, memory) that follow the project. */
  claudeDirs: number;
  /** Linked git worktrees that are repaired after the move. */
  worktrees: string[];
}

export type MovePhase =
  | 'waiting'
  | 'stopping'
  | 'moving'
  | 'copying'
  | 'verifying'
  | 'claude'
  | 'git'
  | 'restarting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface MoveProgress {
  id: string;
  entryId: string;
  phase: MovePhase;
  source: string;
  destination: string;
  bytes?: number;
  totalBytes?: number;
  /** failed: what went wrong; done: things that need the user (a part that couldn't be finished). */
  error?: string;
  notes?: string[];
}

/** Characters Windows doesn't allow in a file name (and names it reserves). */
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|[. ]$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function isValidFolderName(name: string): boolean {
  return name.trim().length > 0 && name.length <= 200 && !BAD_NAME.test(name) && !RESERVED.test(name);
}

/** "<folder>\<name>" with the folder's own separator style. */
export function joinPath(folder: string, name: string): string {
  const sep = folder.includes('\\') || /^[a-z]:/i.test(folder) ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + sep + name;
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i <= 0) return trimmed;
  const parent = trimmed.slice(0, i);
  return /^[a-z]:$/i.test(parent) ? parent + '\\' : parent;
}

/** A drive or share root ("C:\", "\\server\share", "/"). */
export function isRoot(path: string): boolean {
  const p = path.replace(/[\\/]+$/, '');
  return p === '' || /^[a-z]:$/i.test(p) || /^\\\\[^\\]+\\[^\\]+$/.test(p);
}

/** UNC and WSL paths: renames and handle checks there aren't reliable enough to move live projects. */
export function isUnsupportedPath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//');
}

export interface PathChecks {
  source: string;
  destination: string;
  sourceExists: boolean;
  destinationExists: boolean;
  /** Folders that must never move: home, the running exe's folder, Atelier's data, Claude's config. */
  protectedPaths: string[];
}

/** The path-only blockers (pure; main adds space, busy and the rest). */
export function pathBlockers(c: PathChecks): MoveBlocker[] {
  const out: MoveBlocker[] = [];
  const name =
    c.destination
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  if (!c.sourceExists) out.push('source-missing');
  if (pathIdentity(c.source) === pathIdentity(c.destination)) {
    // Only the letter case changes: a rename in place, allowed.
    if (c.source.replace(/[\\/]+$/, '') === c.destination.replace(/[\\/]+$/, '')) out.push('same');
  } else {
    if (c.destinationExists) out.push('dest-exists');
    if (isInsidePath(c.destination, c.source)) out.push('dest-inside-source');
  }
  if (!isValidFolderName(name)) out.push('invalid-name');
  if (
    isRoot(c.source) ||
    c.protectedPaths.some(
      (p) => p && (isInsidePath(p, c.source) || pathIdentity(p) === pathIdentity(c.source)),
    )
  )
    out.push('source-protected');
  if (isUnsupportedPath(c.source) || isUnsupportedPath(c.destination)) out.push('unsupported-path');
  return out;
}

/** Same drive letter (or same Unix root): a rename is enough. Main confirms with EXDEV anyway. */
export function sameVolume(a: string, b: string): boolean {
  const da = /^([a-z]):/i.exec(a)?.[1]?.toLowerCase();
  const db = /^([a-z]):/i.exec(b)?.[1]?.toLowerCase();
  if (da || db) return da === db;
  return true;
}
