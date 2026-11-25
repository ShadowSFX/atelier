import type { ClaudeState } from './ipc';

/** A Claude state worth showing on a project's tab. */
export type ProjectClaudeState = Exclude<ClaudeState, 'idle'>;

/** Most urgent first: an answer the user owes, then work in progress, then a finished turn not looked at yet. */
const URGENCY: readonly ProjectClaudeState[] = ['waiting', 'busy', 'done'];

/**
 * What a project's tab shows from the Claude states of its terminals: the most urgent one, or null when no session is
 * active (idle, or no Claude). Returns a primitive so a store selector built on it only re-renders when it changes.
 */
export function projectClaudeState(
  states: readonly (ClaudeState | null | undefined)[],
): ProjectClaudeState | null {
  return URGENCY.find((s) => states.includes(s)) ?? null;
}
