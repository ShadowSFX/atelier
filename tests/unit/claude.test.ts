import { describe, expect, it } from 'vitest';
import { projectClaudeState } from '@shared/claude';

describe('projectClaudeState', () => {
  it('is null without an active Claude session', () => {
    expect(projectClaudeState([])).toBeNull();
    expect(projectClaudeState([undefined, null, 'idle'])).toBeNull();
  });

  it('shows the most urgent state: waiting, then busy, then done', () => {
    expect(projectClaudeState(['done', 'busy', 'waiting', 'idle'])).toBe('waiting');
    expect(projectClaudeState(['done', 'busy', undefined])).toBe('busy');
    expect(projectClaudeState(['idle', 'done'])).toBe('done');
    expect(projectClaudeState(['busy'])).toBe('busy');
  });
});
