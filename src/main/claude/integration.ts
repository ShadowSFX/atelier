import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWslPath } from '@shared/shell';

/**
 * Files that make `claude` (started from an Atelier terminal) part of its project's hub, passed per session by the
 * shell's `claude` wrapper (--settings / --mcp-config). Nothing is written to the user's projects or ~/.claude, so
 * Claude Code sessions started elsewhere are unaffected.
 *
 * - hooks report the session state (idle / busy / waiting for an answer / done) to the hub, and SessionStart
 *   asks Claude to name its terminal (atelier_set_title);
 * - permissions.deny removes Claude Code's built-in cross-session tools, which see every project on the machine;
 * - the `atelier` MCP server offers project-scoped peers / send / inbox / read_output, and set_title.
 */
export interface ClaudeFiles {
  settings: string;
  mcp: string;
  /** Same, for claude running inside WSL (paths to Atelier's executable as WSL sees them). */
  settingsWsl: string;
  mcpWsl: string;
}

export interface AgentPaths {
  /** Atelier's executable (electron.exe in development); runs the agent scripts with ELECTRON_RUN_AS_NODE=1. */
  exec: string;
  hookScript: string;
  mcpScript: string;
}

/**
 * Frequent events don't block Claude (async); the rare state-defining ones run in order. PostToolUse only matters
 * for the tools that wait for the user (the answer was given): a matcher keeps it from running after every tool.
 */
const HOOKS: { event: string; async: boolean; matcher?: string }[] = [
  { event: 'SessionStart', async: false },
  { event: 'UserPromptSubmit', async: false },
  { event: 'PreToolUse', async: true },
  { event: 'PostToolUse', async: true, matcher: 'AskUserQuestion|ExitPlanMode' },
  { event: 'Notification', async: true },
  { event: 'Stop', async: false },
  { event: 'SessionEnd', async: false },
];

const posix = (p: string) => p.replace(/\\/g, '/');
const sq = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

function settingsJson(hookCommand: string): string {
  const hooks = Object.fromEntries(
    HOOKS.map(({ event, async, matcher }) => [
      event,
      [
        {
          ...(matcher ? { matcher } : {}),
          hooks: [{ type: 'command', command: hookCommand, timeout: 10, ...(async ? { async: true } : {}) }],
        },
      ],
    ]),
  );
  // The atelier_* tools only reach this project's terminals: allowed without a prompt so coordination stays fluid.
  const allow = [
    'atelier_peers',
    'atelier_send',
    'atelier_inbox',
    'atelier_read_output',
    'atelier_set_title',
  ].map((t) => `mcp__atelier__${t}`);
  return JSON.stringify({ permissions: { allow, deny: ['ListAgents', 'SendMessage'] }, hooks }, null, 2);
}

function mcpJson(command: string, args: string[], env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { atelier: { type: 'stdio', command, args, env } } }, null, 2);
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    /* write it */
  }
  writeFileSync(path, content, 'utf8');
}

export function writeClaudeFiles(dir: string, a: AgentPaths): ClaudeFiles {
  mkdirSync(dir, { recursive: true });
  const files: ClaudeFiles = {
    settings: join(dir, 'settings.json'),
    mcp: join(dir, 'mcp.json'),
    settingsWsl: join(dir, 'settings-wsl.json'),
    mcpWsl: join(dir, 'mcp-wsl.json'),
  };

  // Claude Code runs hook commands with bash (Git Bash on Windows): POSIX syntax and forward slashes.
  const hook = `ELECTRON_RUN_AS_NODE=1 ${sq(posix(a.exec))} ${sq(posix(a.hookScript))}`;
  writeIfChanged(files.settings, settingsJson(hook));
  writeIfChanged(files.mcp, mcpJson(a.exec, [a.mcpScript], { ELECTRON_RUN_AS_NODE: '1' }));

  if (process.platform === 'win32') {
    // Inside WSL, claude is a Linux program: it starts Atelier.exe through WSL interop. Variables reach the
    // Windows process only when listed in WSLENV; script paths stay Windows paths (they are Atelier.exe's argv).
    const execWsl = toWslPath(a.exec) ?? posix(a.exec);
    const wslenv = 'WSLENV="$WSLENV:ELECTRON_RUN_AS_NODE:ATELIER_HUB:ATELIER_TOKEN"';
    writeIfChanged(
      files.settingsWsl,
      settingsJson(`${wslenv} ELECTRON_RUN_AS_NODE=1 ${sq(execWsl)} ${sq(a.hookScript)}`),
    );
    writeIfChanged(
      files.mcpWsl,
      mcpJson(execWsl, [a.mcpScript], {
        ELECTRON_RUN_AS_NODE: '1',
        WSLENV: 'ELECTRON_RUN_AS_NODE:ATELIER_HUB:ATELIER_TOKEN',
        ATELIER_HUB: '${ATELIER_HUB}',
        ATELIER_TOKEN: '${ATELIER_TOKEN}',
      }),
    );
  }
  return files;
}
