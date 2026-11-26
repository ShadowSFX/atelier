import { describe, expect, it } from 'vitest';
import { claudeTransition, formatDuration, NotifyThrottle, notifyEnabled } from '@shared/notify';
import { parseSettings } from '@shared/settings';

describe('claudeTransition', () => {
  type Snap = Parameters<typeof claudeTransition>[0];
  const busy: Snap = { state: 'busy' };
  const idle: Snap = { state: 'idle' };
  const done: Snap = { state: 'done' };
  const ended: Snap = { state: null };
  const perm: Snap = { state: 'waiting', asking: 'permission' };
  const ask: Snap = { state: 'waiting', asking: 'question' };
  const waitingUnknown: Snap = { state: 'waiting' };
  it.each([
    ['new → idle', undefined, idle, null], // session started
    ['ended → idle', ended, idle, null],
    ['busy → permission', busy, perm, 'permission'],
    ['busy → question', busy, ask, 'question'],
    ['idle → question', idle, ask, 'question'],
    ['new → permission', undefined, perm, 'permission'],
    ['waiting without a kind', busy, waitingUnknown, 'permission'],
    ['permission republished', perm, perm, null], // queue count changed
    ['question republished', ask, ask, null],
    ['permission → question', perm, ask, 'question'], // a different wait: news again
    ['question → permission', ask, perm, 'permission'],
    ['busy → done', busy, done, 'claudeDone'],
    ['permission → done', perm, done, 'claudeDone'],
    ['question → done', ask, done, 'claudeDone'],
    ['done → done', done, done, null],
    ['done → idle', done, idle, null], // the user looked at it
    ['idle → done', idle, done, null], // no turn ran (not news)
    ['busy → idle', busy, idle, null], // interrupted with Esc
    ['busy → ended', busy, ended, null], // session ended
    ['permission → busy', perm, busy, null], // answered
  ] as const)('%s', (_name, prev, next, expected) => {
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
    expect(notifyEnabled(on, 'permission')).toBe(true);
    expect(notifyEnabled(on, 'question')).toBe(true);
    expect(notifyEnabled(on, 'bell')).toBe(true);
    expect(notifyEnabled({ ...on, notifications: false }, 'permission')).toBe(false);
    expect(notifyEnabled({ ...on, notifyPermission: false }, 'permission')).toBe(false);
    expect(notifyEnabled({ ...on, notifyPermission: false }, 'question')).toBe(true);
    expect(notifyEnabled({ ...on, notifyQuestion: false }, 'question')).toBe(false);
    expect(notifyEnabled({ ...on, notifyQuestion: false }, 'permission')).toBe(true);
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
    expect(s.notifySound).toBe(true);
    expect(s.notifyPermission).toBe(true);
    expect(s.notifyQuestion).toBe(true);
  });

  it('carries the old single "needs your answer" switch over to both new ones', () => {
    const off = parseSettings({ notifyWaiting: false });
    expect(off.notifyPermission).toBe(false);
    expect(off.notifyQuestion).toBe(false);
    expect('notifyWaiting' in off).toBe(false); // dropped on the next save
    expect(parseSettings({ notifyWaiting: true }).notifyQuestion).toBe(true);
    // A file that already has the new keys keeps them.
    const mixed = parseSettings({ notifyWaiting: false, notifyPermission: true });
    expect(mixed.notifyPermission).toBe(true);
    expect(mixed.notifyQuestion).toBe(false);
    expect(parseSettings({ notifyWaiting: 'no' }).notifyPermission).toBe(true);
    expect(parseSettings(null).notifyPermission).toBe(true);
  });

  it('turns the sound off', () => {
    expect(parseSettings({ notifySound: false }).notifySound).toBe(false);
    expect(parseSettings({ notifySound: 3 }).notifySound).toBe(true);
  });
});
