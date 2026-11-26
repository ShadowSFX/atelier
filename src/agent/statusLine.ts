/**
 * Claude Code statusLine command for sessions started in an Atelier terminal. Run with ELECTRON_RUN_AS_NODE=1 by
 * the bash snippet in claude/integration.ts, with Claude's statusLine JSON on stdin. It:
 * 1. sends `rate_limits` (the plan's weekly and 5-hour usage) to the hub, for Atelier's status bar;
 * 2. prints the user's own statusLine command, if they have one: Atelier's --settings replaced it, so the snippet
 *    runs it with the same input and Claude shows its output as before. It prints nothing otherwise.
 * It must be fast and never disturb Claude: any failure exits 0 silently.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseRateLimits, userStatusLineCommand } from '@shared/usage';
import { hubEnv, sendOnce } from './hubClient';
import { print, readStdin } from './io';
import { statusLineSources, type StatusInput } from './statusSources';

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null; // missing or not JSON: like Claude Code, skip it
  }
}

async function report(input: { rate_limits?: unknown }): Promise<void> {
  const env = hubEnv();
  if (!env || !parseRateLimits(input.rate_limits, Date.now())) return;
  await sendOnce(env, { t: 'usage', rateLimits: input.rate_limits }, 800, 'status');
}

async function chained(input: StatusInput): Promise<void> {
  const files = statusLineSources(input, process.env, process.platform, homedir());
  const command = userStatusLineCommand(await Promise.all(files.map(readJsonFile)));
  if (command) await print(command);
}

async function main(): Promise<void> {
  let input: StatusInput & { rate_limits?: unknown };
  try {
    input = JSON.parse(await readStdin(2000)) as typeof input;
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  await Promise.all([report(input).catch(() => undefined), chained(input).catch(() => undefined)]);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
