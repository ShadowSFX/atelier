/**
 * Claude Code hook (all events) for sessions started in an Atelier terminal: tells the hub what the session is
 * doing (idle, busy, waiting for permission). Runs with ELECTRON_RUN_AS_NODE=1. It must be fast and must never
 * disturb Claude: any failure exits 0 silently.
 */
import type { HookEvent } from '@shared/hub';
import { hubEnv, sendOnce } from './hubClient';

const startedAt = Date.now();
const EVENTS = new Set<HookEvent>(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']);

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const env = hubEnv();
  if (!env) return;
  let input: { hook_event_name?: string; notification_type?: string } = {};
  try {
    input = JSON.parse(await readStdin(2000)) as typeof input;
  } catch {
    return;
  }
  const event = input.hook_event_name as HookEvent;
  if (!EVENTS.has(event)) return;
  await sendOnce(env, {
    t: 'hook',
    event,
    at: startedAt,
    ...(typeof input.notification_type === 'string' ? { notificationType: input.notification_type } : {}),
  });
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
