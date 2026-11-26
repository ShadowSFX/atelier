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
  const files = writeClaudeFiles(dir, {
    exec: 'C:\\My Apps\\Atelier.exe',
    hookScript: 'h.js',
    mcpScript: 'm.js',
    statusScript: 'C:\\My Apps\\out\\agent-status.js',
  });
  type ClaudeSettings = {
    permissions: { allow: string[]; deny: string[] };
    hooks: Record<string, HookGroup[]>;
    statusLine: { type: string; command: string; padding: number };
  };
  const settings = JSON.parse(readFileSync(files.settings, 'utf8')) as ClaudeSettings;

  it('reports usage from a statusLine that chains the user’s own one', () => {
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.padding).toBe(0);
    const cmd = settings.statusLine.command;
    // Atelier's script reads Claude's input; whatever command it prints runs with the same input, in bash.
    expect(cmd).toContain('ELECTRON_RUN_AS_NODE=1 "C:/My Apps/Atelier.exe" "C:/My Apps/out/agent-status.js"');
    expect(cmd).toMatch(/^input=\$\(cat\); cmd=\$\(printf '%s' "\$input" \| /);
    expect(cmd).toContain(`[ -z "$cmd" ] || printf '%s' "$input" | "\${BASH:-bash}" -c "$cmd"`);
  });

  it.runIf(process.platform === 'win32')('passes WSL the variables the status script needs', () => {
    const wsl = JSON.parse(readFileSync(files.settingsWsl, 'utf8')) as ClaudeSettings;
    const cmd = wsl.statusLine.command;
    expect(cmd).toContain('ATELIER_STATUS_KIND=wsl ATELIER_STATUS_HOME="$HOME"');
    expect(cmd).toMatch(
      /WSLENV="\$WSLENV:[^"]*ATELIER_TOKEN:ATELIER_STATUS_KIND:ATELIER_STATUS_HOME:WSL_DISTRO_NAME/,
    );
    expect(cmd).toContain('"/mnt/c/My Apps/Atelier.exe" "C:\\\\My Apps\\\\out\\\\agent-status.js"');
  });

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
