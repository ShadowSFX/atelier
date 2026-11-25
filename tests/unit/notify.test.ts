import { describe, expect, it } from 'vitest';
import { claudeTransition, formatDuration, NotifyThrottle, notifyEnabled } from '@shared/notify';
import { parseSettings } from '@shared/settings';

describe('claudeTransition', () => {
  it.each([
    [undefined, 'idle', null], // session started
    [null, 'idle', null],
    ['busy', 'waiting', 'waiting'], // permission prompt, question, plan approval
    ['idle', 'waiting', 'waiting'],
    [undefined, 'waiting', 'waiting'],
    ['waiting', 'waiting', null], // same state published again (queue count changed)
    ['busy', 'done', 'claudeDone'],
    ['waiting', 'done', 'claudeDone'],
    ['done', 'done', null],
    ['done', 'idle', null], // the user looked at it
    ['idle', 'done', null], // no turn ran (not news)
    ['busy', 'idle', null], // interrupted with Esc
    ['busy', null, null], // session ended
    ['waiting', 'busy', null], // answered
  ] as const)('%s → %s = %s', (prev, next, expected) => {
    expect(claudeTransition(prev, next)).toBe(expected);
  });
});

describe('NotifyThrottle', () => {
  it('allows one per terminal and kind per window', () => {
    const th = new NotifyThrottle(10_000);
    expect(th.allow('t1', 'bell', 0)).toBe(true);
    expect(th.allow('t1', 'bell', 9_999)).toBe(false);
    expect(th.allow('t1', 'command', 5_000)).toBe(true); // other kind
    expect(th.allow('t2', 'bell', 5_000)).toBe(true); // other terminal
    expect(th.allow('t1', 'bell', 10_000)).toBe(true); // window passed
  });

  it('forgets a closed terminal (and only that one)', () => {
    const th = new NotifyThrottle(10_000);
    th.allow('t1', 'bell', 0);
    th.allow('t10', 'bell', 0);
    th.forget('t1');
    expect(th.allow('t1', 'bell', 1)).toBe(true);
    expect(th.allow('t10', 'bell', 1)).toBe(false);
  });
});

describe('notifyEnabled', () => {
  it('needs the master switch and the event switch', () => {
    const on = parseSettings({});
    expect(notifyEnabled(on, 'waiting')).toBe(true);
    expect(notifyEnabled(on, 'bell')).toBe(true);
    expect(notifyEnabled({ ...on, notifications: false }, 'waiting')).toBe(false);
    expect(notifyEnabled({ ...on, notifyBell: false }, 'bell')).toBe(false);
    expect(notifyEnabled({ ...on, notifyBell: false }, 'command')).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [Number.NaN, '0s'],
    [999, '0s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [185_000, '3m 05s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 00m'],
    [3_720_000, '1h 02m'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('notification settings', () => {
  it('defaults to on with a 10 s threshold and clamps it', () => {
    const s = parseSettings({});
    expect(s.notifications).toBe(true);
    expect(s.notifyLongCommandSeconds).toBe(10);
    expect(parseSettings({ notifyLongCommandSeconds: 0 }).notifyLongCommandSeconds).toBe(1);
    expect(parseSettings({ notifyLongCommandSeconds: 99_999 }).notifyLongCommandSeconds).toBe(3600);
    expect(parseSettings({ notifyLongCommandSeconds: 'x' }).notifyLongCommandSeconds).toBe(10);
    expect(parseSettings({ notifyLongCommandSeconds: 2.6 }).notifyLongCommandSeconds).toBe(3);
    expect(parseSettings({ notifications: 'yes' }).notifications).toBe(true);
  });
});
