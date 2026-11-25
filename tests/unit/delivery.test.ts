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

  it('delivers by hand even when busy', () => {
    const { d, writes } = setup();
    d.hook('a2', 'Notification', 'permission_prompt');
    expect(d.claudeState('a2')).toBe('permission');
    d.send('A', 'a1', 'a2', 'msg');
    d.flush('a2', true);
    expect(writes).toHaveLength(1);
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
    for (let i = 0; i < HUB_RATE_PER_MINUTE; i++) expect(d.send('A', 'a1', 'a2', `m${i}`)[0]!.status).toBe('queued');
    expect(d.send('A', 'a1', 'a2', 'over')[0]!.reason).toMatch(/rate limit/);
    tick(61_000);
    expect(d.send('A', 'a1', 'a2', 'later')[0]!.status).toBe('queued');
  });

  it('ignores hooks that arrive out of order', () => {
    const { d, at } = setup();
    const t0 = at();
    d.hook('a2', 'Stop', undefined, t0 + 10);
    d.hook('a2', 'PreToolUse', undefined, t0 + 5); // an async hook that started before Stop
    expect(d.claudeState('a2')).toBe('idle');
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

  it('strips ESC from messages so they cannot break out of the paste', () => {
    const { d, writes } = setup();
    d.hook('a2', 'SessionStart');
    d.send('A', 'a1', 'a2', 'evil\x1b[201~\rrm -rf /');
    const body = writes[0]!.data.slice(6, -6);
    expect(body).not.toContain('\x1b');
  });
});
