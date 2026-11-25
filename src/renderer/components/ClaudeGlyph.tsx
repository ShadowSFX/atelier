import type { ClaudeState } from '@shared/ipc';
import { cx } from './Button';
import s from './ClaudeGlyph.module.css';

/** The i18n key naming each Claude state. */
export const CLAUDE_LABEL = {
  idle: 'claude.idle',
  busy: 'claude.busy',
  waiting: 'claude.waiting',
  done: 'claude.done',
} as const satisfies Record<ClaudeState, string>;

/**
 * A Claude session's state as a glyph, the same shapes as the sidebar row's status: hollow ring (idle), turning arc
 * (busy), dot with a halo (waiting), check mark drawn once (done). The shape differs per state, so it reads without
 * color or motion. Decorative: the caller names the state (tooltip or label).
 */
export function ClaudeGlyph({ state, className }: { state: ClaudeState; className?: string }) {
  return (
    <span className={cx(s.box, s[state], className)} data-claude-glyph={state} aria-hidden>
      {state === 'done' ? (
        <svg className={s.check} viewBox="0 0 10 10">
          <path d="M2 5.3 4.2 7.4 8 3" />
        </svg>
      ) : (
        <span className={s.glyph} />
      )}
    </span>
  );
}
