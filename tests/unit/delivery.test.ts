import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_RATE_PER_MINUTE } from '@shared/constants';
import type { ClaudeStatus } from '@shared/ipc';
import { Delivery } from '../../src/main/hub/Delivery';

const PEERS: Record<string, { id: string; name: string; color: null; cwd: null }[]> = {
  A: [
    { id: 'a1', name: 'api', color: null, cwd: null },
    { id: 'a2', name: 'web', color: null, cwd: null },
    { id: 'a3', name: 'tests', color: null, cwd: null },
  ],
  B: [{ id: 'b1', name: 'other', color: null, cwd: null }],
};

function setup() {
  const writes: { id: string; data: string }[] = [];
  const statuses: ClaudeStatus[] = [];
  let now = 1_000_000;
  const d = new Delivery({
    peersOf: (p) => PEERS[p] ?? [],
    write: (id, data) => {
      writes.push({ id, data });
      return true;
    },
    onStatus: (s) => statuses.push(s),
    now: () => now,
  });
  return { d, writes, statuses, tick: (ms: number) => (now += ms), at: () => now };
}

describe('Delivery', () => {
  beforeEach(() => vi.useFakeTimers());

  it('only lists and reaches terminals of the same project', () => {
    const { d } = setup();
    d.hook('b1', 'SessionStart');
    expect(d.peers('A', 'a1').map((p) => p.id)).toEqual(['a1', 'a2', 'a3']);
    expect(d.peers('A', 'a1')[0]!.self).toBe(true);
    const r = d.send('A', 'a1', 'b1', 'hello');
    expect(r[0]!.status).toBe('rejected');
  });

  it('types the message into an idle session right away, then Enter', () => {
    const { d, writes } = setup();
    d.hook('a2', 'SessionStart');
    expect(d.send('A', 'a1', 'a2', 'please run the tests')[0]!.status).toBe('delivered');
    expect(writes[0]!.id).toBe('a2');
    expect(writes[0]!.data.startsWith('\x1b[200~')).toBe(true);
    expect(writes[0]!.data).toContain('please run the tests');
    expect(writes[0]!.data).toContain('"api"');
    vi.runAllTimers();
    expect(writes[1]).toEqual({ id: 'a2', data: '\r' });
    expect(d.claudeState('a2')).toBe('busy');
  });

  it('queues while busy and delivers everything on Stop', () => {
    const { d, writes } = setup();
    d.hook('a2', 'UserPromptSubmit');
    expect(d.send('A', 'a1', 'a2', 'one')[0]!.status).toBe('queued');
    expect(d.send('A', 'a3', 'a2', 'two')[0]!.status).toBe('queued');
    expect(writes).toHaveLength(0);
    d.hook('a2', 'Stop');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toContain('one');
    expect(writes[0]!.data).toContain('two');
  });

  it('waits while the user is typing in that terminal', () => {
    const { d, writes } = setup();
    d.hook('a2', 'Stop');
    d.userInput('a2', 'h');
    expect(d.send('A', 'a1', 'a2', 'msg')[0]!.status).toBe('queued');
    expect(writes).toHaveLength(0);
    d.userInput('a2', '\x15'); // Ctrl+U clears the line
    d.flush('a2');
    expect(writes).toHaveLength(1);
  });

  it('delivers by hand even when busy, but never into a permission prompt', () => {
    const { d, writes } = setup();
    d.hook('a2', 'Notification', 'permission_prompt');
    expect(d.claudeState('a2')).toBe('waiting');
    d.send('A', 'a1', 'a2', 'msg');
    d.flush('a2', true);
    expect(writes).toHaveLength(0); // Enter would answer the prompt
    d.userInput('a2', '\r'); // the user answers it
    expect(d.claudeState('a2')).toBe('busy');
    d.flush('a2', true);
    expect(writes).toHaveLength(1);
  });

  it('keeps a draft typed while Claude worked, ignores focus and mouse reports', () => {
    const { d, writes } = setup();
    d.hook('a2', 'UserPromptSubmit');
    d.userInput('a2', 'next question');
    d.hook('a2', 'Stop');
    d.send('A', 'a1', 'a2', 'msg');
    expect(writes).toHaveLength(0); // would be merged with the draft
    d.userInput('a2', '\x15');
    d.userInput('a2', '\x1b[I');
    d.userInput('a2', '\x1b[<0;10;5M');
    d.flush('a2');
    expect(writes).toHaveLength(1);
  });

  it('forgets the session when the shell prompt comes back', () => {
    const { d } = setup();
    d.hook('a2', 'SessionStart');
    d.shellPrompt('a2');
    expect(d.claudeState('a2')).toBeNull();
    expect(d.send('A', 'a1', 'a2', 'x')[0]!.status).toBe('rejected');
  });

  it('rejects terminals without Claude, empty and oversized messages', () => {
    const { d } = setup();
    expect(d.send('A', 'a1', 'a2', 'x')[0]!.reason).toMatch(/no Claude/);
    d.hook('a2', 'SessionStart');
    expect(d.send('A', 'a1', 'a2', '   ')[0]!.status).toBe('rejected');
    expect(d.send('A', 'a1', 'a2', 'x'.repeat(9000))[0]!.status).toBe('rejected');
    expect(d.send('A', 'a1', 'a1', 'me')[0]!.status).toBe('rejected');
  });

  it('broadcasts to every other Claude session of the project', () => {
    const { d } = setup();
    for (const id of ['a1', 'a2', 'a3', 'b1']) d.hook(id, 'SessionStart');
    const r = d.send('A', 'a1', 'all', 'standup');
    expect(r.map((x) => x.to).sort()).toEqual(['a2', 'a3']);
  });

  it('rate-limits a pair of sessions (stops message loops)', () => {
    const { d, tick } = setup();
    d.hook('a2', 'UserPromptSubmit');
    for (let i = 0; i < HUB_RATE_PER_MINUTE; i++)
      expect(d.send('A', 'a1', 'a2', `m${i}`)[0]!.status).toBe('queued');
    expect(d.send('A', 'a1', 'a2', 'over')[0]!.reason).toMatch(/rate limit/);
    tick(61_000);
    expect(d.send('A', 'a1', 'a2', 'later')[0]!.status).toBe('queued');
  });

  it('ignores hooks that arrive out of order', () => {
    const { d, at } = setup();
    const t0 = at();
    d.hook('a2', 'Stop', undefined, t0 + 10);
    d.hook('a2', 'PreToolUse', undefined, t0 + 5); // an async hook that started before Stop
    expect(d.claudeState('a2')).toBe('done');
  });

  it('inbox returns new messages once and removes them from the queue', () => {
    const { d, writes } = setup();
    d.hook('a2', 'UserPromptSubmit');
    d.send('A', 'a1', 'a2', 'queued msg');
    const inbox = d.inbox('a2');
    expect(inbox.map((m) => m.text)).toEqual(['queued msg']);
    expect(d.inbox('a2')).toEqual([]);
    d.hook('a2', 'Stop');
    expect(writes).toHaveLength(0);
  });

  it('forgets a closed terminal', () => {
    const { d, statuses } = setup();
    d.hook('a2', 'SessionStart');
    d.terminalGone('a2');
    expect(d.claudeState('a2')).toBeNull();
    expect(statuses.at(-1)).toEqual({ terminalId: 'a2', state: null, queued: 0 });
  });

  it('strips control characters so a message cannot break out of the paste', () => {
    const { d, writes } = setup();
    d.hook('a2', 'SessionStart');
    d.send('A', 'a1', 'a2', 'evil\x1b[201~\rrm -rf /\x03\x9b201~ ok\nline 2');
    const body = writes[0]!.data.slice(6, -6);
    // eslint-disable-next-line no-control-regex
    expect(body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(body).toContain('line 2');
  });

  describe('status for the sidebar', () => {
    it('finishes a turn as done, which becomes idle once the user types or looks', () => {
      const { d, statuses } = setup();
      d.hook('a2', 'UserPromptSubmit');
      d.hook('a2', 'Stop');
      expect(d.claudeState('a2')).toBe('done');
      expect(statuses.at(-1)).toEqual({ terminalId: 'a2', state: 'done', queued: 0 });
      d.userInput('a2', '\x1b[I'); // a focus report is not the user typing
      expect(d.claudeState('a2')).toBe('done');
      d.userInput('a2', 'n');
      expect(d.claudeState('a2')).toBe('idle');
      expect(statuses.at(-1)!.state).toBe('idle');

      d.hook('a2', 'UserPromptSubmit');
      d.hook('a2', 'Stop');
      d.seen('a2');
      expect(d.claudeState('a2')).toBe('idle');
    });

    it('seen only changes a finished turn', () => {
      const { d, statuses } = setup();
      d.seen('a2'); // no session
      expect(d.claudeState('a2')).toBeNull();
      d.hook('a2', 'UserPromptSubmit');
      const before = statuses.length;
      d.seen('a2');
      expect(d.claudeState('a2')).toBe('busy');
      expect(statuses).toHaveLength(before);
    });

    it('waits for the answer to a question or a plan until PostToolUse, whatever keys are pressed', () => {
      const { d } = setup();
      d.hook('a2', 'UserPromptSubmit');
      d.hook('a2', 'PreToolUse', undefined, undefined, 'AskUserQuestion');
      expect(d.claudeState('a2')).toBe('waiting');
      d.userInput('a2', '\r'); // first of several questions
      d.userInput('a2', '\x1b[B');
      expect(d.claudeState('a2')).toBe('waiting');
      d.hook('a2', 'PostToolUse', undefined, undefined, 'AskUserQuestion');
      expect(d.claudeState('a2')).toBe('busy');

      d.hook('a2', 'PreToolUse', undefined, undefined, 'ExitPlanMode');
      expect(d.claudeState('a2')).toBe('waiting');
      d.hook('a2', 'PreToolUse', undefined, undefined, 'Bash');
      expect(d.claudeState('a2')).toBe('busy');
    });

    it('a notification during an open question does not let Enter end the wait', () => {
      const { d } = setup();
      d.hook('a2', 'PreToolUse', undefined, undefined, 'AskUserQuestion');
      d.hook('a2', 'Notification', 'permission_prompt');
      d.userInput('a2', '\r');
      expect(d.claudeState('a2')).toBe('waiting');
    });

    it('treats an MCP elicitation like a permission prompt', () => {
      const { d } = setup();
      d.hook('a2', 'Notification', 'elicitation_dialog');
      expect(d.claudeState('a2')).toBe('waiting');
      d.userInput('a2', '\x1b');
      expect(d.claudeState('a2')).toBe('busy');
    });

    it('says what a waiting session asks for (permission or question), only while it waits', () => {
      const { d, statuses } = setup();
      const asking = () => statuses.at(-1)!.asking;
      d.hook('a2', 'UserPromptSubmit');
      expect(asking()).toBeUndefined();
      d.hook('a2', 'PreToolUse', undefined, undefined, 'Bash');
      d.hook('a2', 'Notification', 'permission_prompt');
      expect(asking()).toBe('permission');
      d.hook('a2', 'Notification', 'idle_prompt'); // still waiting, still a permission
      expect(asking()).toBe('permission');
      d.userInput('a2', '\r'); // answered
      expect(statuses.at(-1)).toEqual({ terminalId: 'a2', state: 'busy', queued: 0 });

      d.hook('a2', 'PreToolUse', undefined, undefined, 'AskUserQuestion');
      expect(asking()).toBe('question');
      d.hook('a2', 'Notification', 'permission_prompt'); // the question's own prompt
      expect(asking()).toBe('question');
      d.hook('a2', 'PostToolUse', undefined, undefined, 'AskUserQuestion');
      expect(asking()).toBeUndefined();

      d.hook('a2', 'PreToolUse', undefined, undefined, 'ExitPlanMode');
      expect(asking()).toBe('question');
      d.hook('a2', 'PostToolUse', undefined, undefined, 'ExitPlanMode');
      d.hook('a2', 'Notification', 'elicitation_dialog'); // an MCP server's form
      expect(asking()).toBe('question');
      d.hook('a2', 'Stop');
      expect(statuses.at(-1)).toEqual({ terminalId: 'a2', state: 'done', queued: 0 });
    });

    it('idle_prompt heals a turn interrupted without Stop, but keeps waiting and done', () => {
      const { d } = setup();
      d.hook('a1', 'UserPromptSubmit');
      d.hook('a1', 'Notification', 'idle_prompt');
      expect(d.claudeState('a1')).toBe('idle');
      d.hook('a2', 'Notification', 'permission_prompt');
      d.hook('a2', 'Notification', 'idle_prompt');
      expect(d.claudeState('a2')).toBe('waiting');
      d.hook('a3', 'Stop');
      d.hook('a3', 'Notification', 'idle_prompt');
      expect(d.claudeState('a3')).toBe('done');
    });

    it('types messages into a finished session like an idle one', () => {
      const { d, writes } = setup();
      d.hook('a2', 'Stop');
      expect(d.send('A', 'a1', 'a2', 'next step')[0]!.status).toBe('delivered');
      expect(writes[0]!.data).toContain('next step');
      expect(d.claudeState('a2')).toBe('busy');
    });

    it('never delivers by hand into a question waiting for an answer', () => {
      const { d, writes } = setup();
      d.hook('a2', 'PreToolUse', undefined, undefined, 'AskUserQuestion');
      d.send('A', 'a1', 'a2', 'msg');
      d.flush('a2', true);
      expect(writes).toHaveLength(0);
    });
  });
});
