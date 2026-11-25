import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeClaudeFiles } from '../../src/main/claude/integration';

const dir = mkdtempSync(join(tmpdir(), 'atelier-claude-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean }[];
}

describe('Claude Code integration files', () => {
  const files = writeClaudeFiles(dir, { exec: 'C:\\A\\Atelier.exe', hookScript: 'h.js', mcpScript: 'm.js' });
  const settings = JSON.parse(readFileSync(files.settings, 'utf8')) as {
    permissions: { allow: string[]; deny: string[] };
    hooks: Record<string, HookGroup[]>;
  };

  it('lets Claude name its terminal without a permission prompt', () => {
    expect(settings.permissions.allow).toContain('mcp__atelier__atelier_set_title');
  });

  it('runs PostToolUse only for the tools that wait for the user, without blocking', () => {
    const post = settings.hooks.PostToolUse![0]!;
    expect(post.matcher).toBe('AskUserQuestion|ExitPlanMode');
    expect(post.hooks[0]!.async).toBe(true);
    // The others have no matcher: they run for every tool / prompt.
    expect(settings.hooks.PreToolUse![0]!.matcher).toBeUndefined();
  });

  it('keeps SessionStart synchronous (its output reaches Claude as context)', () => {
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.async).toBeUndefined();
  });
});
