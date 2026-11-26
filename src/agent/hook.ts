/**
 * Claude Code hook (all events) for sessions started in an Atelier terminal: tells the hub what the session is
 * doing (idle, busy, waiting for an answer, done). On SessionStart it also gives Claude a short instruction (as
 * additional context) to name its terminal with atelier_set_title. Runs with ELECTRON_RUN_AS_NODE=1. It must be
 * fast and must never disturb Claude: any failure exits 0 silently.
 */
import type { HookEvent } from '@shared/hub';
import { CODE_MODE_ENV } from '@shared/constants';
import { hubEnv, sendOnce } from './hubClient';

const startedAt = Date.now();
const EVENTS = new Set<HookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionEnd',
]);

const SESSION_CONTEXT =
  'This session runs in an Atelier terminal, which the user sees in a sidebar next to their other terminals. ' +
  'Whenever you start a plan or a new piece of work (not a follow-up on the current one), call the ' +
  'atelier_set_title tool with a short title for it: 2-5 words, in the language the user writes in. If it ' +
  'answers that the user named the terminal by hand, leave the title alone.';

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

/** Writes to stdout and waits until it is flushed (pipe writes can still be pending when the process exits). */
function print(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  const env = hubEnv();
  if (!env) return;
  let input: {
    hook_event_name?: string;
    notification_type?: string;
    tool_name?: string;
    session_id?: string;
    source?: string;
  } = {};
  try {
    input = JSON.parse(await readStdin(2000)) as typeof input;
  } catch {
    return;
  }
  const event = input.hook_event_name as HookEvent;
  if (!EVENTS.has(event)) return;
  if (event === 'SessionStart') {
    await print(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT },
      }),
    );
  }
  await sendOnce(env, {
    t: 'hook',
    event,
    at: startedAt,
    ...(typeof input.notification_type === 'string' ? { notificationType: input.notification_type } : {}),
    ...(typeof input.tool_name === 'string' ? { tool: input.tool_name.slice(0, 64) } : {}),
    // The session id lets Atelier resume this session after a restart; the hook inherits Claude's environment, so
    // Code Mode is known even for a `claude` typed by hand.
    ...(event === 'SessionStart' && typeof input.session_id === 'string'
      ? {
          sessionId: input.session_id.slice(0, 64),
          ...(typeof input.source === 'string' ? { source: input.source.slice(0, 32) } : {}),
          codeMode: process.env[CODE_MODE_ENV] === '1',
        }
      : {}),
  });
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
