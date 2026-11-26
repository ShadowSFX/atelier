import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  displayPercent,
  liveUsage,
  nextReset,
  parseRateLimits,
  resetLabel,
  userStatusLineCommand,
  type ClaudeUsage,
} from '@shared/usage';
import { statusLineSources } from '../../src/agent/statusSources';
import { UsageService } from '../../src/main/claude/usage';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const sec = (ms: number) => ms / 1000;
const DAY = 86400_000;

describe('parseRateLimits', () => {
  it('reads Claude Code’s windows (seconds → ms)', () => {
    const u = parseRateLimits(
      {
        five_hour: { used_percentage: 23.5, resets_at: sec(NOW + 3600_000) },
        seven_day: { used_percentage: 41.2, resets_at: sec(NOW + 3 * DAY) },
      },
      NOW,
    );
    expect(u).toEqual({
      fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 3600_000 },
      sevenDay: { usedPercentage: 41.2, resetsAt: NOW + 3 * DAY },
      at: NOW,
    });
  });

  it('clamps percentages and keeps a window that comes alone', () => {
    const resets = sec(NOW + DAY);
    expect(
      parseRateLimits({ seven_day: { used_percentage: 130, resets_at: resets } }, NOW)?.sevenDay,
    ).toEqual({ usedPercentage: 100, resetsAt: NOW + DAY });
    const low = parseRateLimits({ five_hour: { used_percentage: -5, resets_at: resets } }, NOW);
    expect(low?.fiveHour?.usedPercentage).toBe(0);
    expect(low?.sevenDay).toBeNull();
  });

  it('rejects garbage, reset windows and far-future resets', () => {
    const resets = sec(NOW + DAY);
    expect(parseRateLimits(undefined, NOW)).toBeNull();
    expect(parseRateLimits('x', NOW)).toBeNull();
    expect(parseRateLimits({}, NOW)).toBeNull();
    expect(parseRateLimits({ seven_day: { used_percentage: '41', resets_at: resets } }, NOW)).toBeNull();
    expect(parseRateLimits({ seven_day: { used_percentage: NaN, resets_at: resets } }, NOW)).toBeNull();
    expect(
      parseRateLimits({ seven_day: { used_percentage: 4, resets_at: sec(NOW - 1000) } }, NOW),
    ).toBeNull();
    expect(
      parseRateLimits({ seven_day: { used_percentage: 4, resets_at: sec(NOW + 400 * DAY) } }, NOW),
    ).toBeNull();
  });
});

describe('liveUsage / nextReset / displayPercent', () => {
  const u: ClaudeUsage = {
    sevenDay: { usedPercentage: 41, resetsAt: NOW + 3 * DAY },
    fiveHour: { usedPercentage: 10, resetsAt: NOW + 3600_000 },
    at: NOW - 1000,
  };

  it('drops windows that have reset, and is null when none is left', () => {
    expect(liveUsage(u, NOW)).toEqual(u);
    expect(liveUsage(u, NOW + 2 * 3600_000)).toEqual({ ...u, fiveHour: null });
    expect(liveUsage(u, NOW + 4 * DAY)).toBeNull();
    expect(liveUsage(null, NOW)).toBeNull();
    expect(liveUsage({ sevenDay: { usedPercentage: 'x', resetsAt: NOW + DAY } }, NOW)).toBeNull();
  });

  it('finds the next reset', () => {
    expect(nextReset(u)).toBe(NOW + 3600_000);
    expect(nextReset({ ...u, fiveHour: null })).toBe(NOW + 3 * DAY);
    expect(nextReset(null)).toBeNull();
  });

  it('shows 100% only at the limit', () => {
    expect(displayPercent(99.6)).toBe(99);
    expect(displayPercent(100)).toBe(100);
    expect(displayPercent(41.2)).toBe(41);
    expect(displayPercent(0.4)).toBe(0);
    expect(displayPercent(NaN)).toBe(0);
  });
});

describe('the user’s own statusLine', () => {
  const line = (command: unknown, type: unknown = 'command') => ({ statusLine: { type, command } });

  it('takes the first settings file that defines one', () => {
    expect(userStatusLineCommand([null, line('local.sh'), line('user.sh')])).toBe('local.sh');
    expect(userStatusLineCommand([{ hooks: {} }, null, line('user.sh')])).toBe('user.sh');
    expect(userStatusLineCommand([null, {}, 'oops'])).toBeNull();
  });

  it('stops at a statusLine it can’t run, and never chains Atelier’s own', () => {
    expect(userStatusLineCommand([line('x', 'other'), line('user.sh')])).toBeNull();
    expect(userStatusLineCommand([line('   '), line('user.sh')])).toBeNull();
    expect(userStatusLineCommand([line('"C:/A/Atelier.exe" "C:/A/out/main/agent-status.js"')])).toBeNull();
  });

  it('looks in the project, then the Claude config folder', () => {
    const win = statusLineSources({ workspace: { project_dir: 'C:\\p' } }, {}, 'win32', 'C:\\Users\\u');
    expect(win.map((p) => p.replace(/\\/g, '/'))).toEqual([
      'C:/p/.claude/settings.local.json',
      'C:/p/.claude/settings.json',
      'C:/Users/u/.claude/settings.json',
    ]);
    const custom = statusLineSources(
      { cwd: '/c/p' },
      { CLAUDE_CONFIG_DIR: '/c/cfg' },
      'win32',
      'C:\\Users\\u',
    );
    expect(custom.map((p) => p.replace(/\\/g, '/'))).toEqual([
      'C:/p/.claude/settings.local.json',
      'C:/p/.claude/settings.json',
      'C:/cfg/settings.json',
    ]);
  });

  it('maps a WSL session’s Linux paths through its distro', () => {
    const env = { ATELIER_STATUS_KIND: 'wsl', WSL_DISTRO_NAME: 'Ubuntu', ATELIER_STATUS_HOME: '/home/u' };
    const paths = statusLineSources(
      { workspace: { project_dir: '/home/u/p' } },
      env,
      'win32',
      'C:\\Users\\x',
    );
    expect(paths.map((p) => p.replace(/\\/g, '/'))).toEqual([
      '//wsl.localhost/Ubuntu/home/u/p/.claude/settings.local.json',
      '//wsl.localhost/Ubuntu/home/u/p/.claude/settings.json',
      '//wsl.localhost/Ubuntu/home/u/.claude/settings.json',
    ]);
  });
});

describe('UsageService', () => {
  afterEach(() => vi.useRealTimers());

  const memoryStore = (initial: ClaudeUsage | null = null) => {
    let value = initial;
    return {
      get: () => value,
      set: (v: ClaudeUsage | null) => void (value = v),
      flushPending: () => undefined,
    };
  };

  it('keeps the newest report and drops each window when it resets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const emitted: (ClaudeUsage | null)[] = [];
    const store = memoryStore();
    const svc = new UsageService(store, (u) => emitted.push(u));
    svc.update({
      sevenDay: { usedPercentage: 41, resetsAt: NOW + 2 * DAY },
      fiveHour: { usedPercentage: 10, resetsAt: NOW + 3600_000 },
      at: 0,
    });
    expect(emitted).toHaveLength(1);
    expect(svc.current()?.at).toBe(NOW); // stamped on receipt

    // The same figures again within a minute: not sent again. A change is.
    const same = { ...svc.current()!, at: 0 };
    vi.advanceTimersByTime(10_000);
    svc.update(same);
    expect(emitted).toHaveLength(1);
    svc.update({ ...same, sevenDay: { usedPercentage: 42, resetsAt: NOW + 2 * DAY } });
    expect(emitted).toHaveLength(2);
    // A report without the 5-hour window keeps its last figure.
    svc.update({ sevenDay: { usedPercentage: 41, resetsAt: NOW + 2 * DAY }, fiveHour: null, at: 0 });
    expect(emitted).toHaveLength(3);
    expect(emitted[2]?.fiveHour).toEqual({ usedPercentage: 10, resetsAt: NOW + 3600_000 });

    vi.advanceTimersByTime(3600_000 + 1000 - 10_000);
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 41 } });

    vi.advanceTimersByTime(2 * DAY);
    expect(emitted.at(-1)).toBeNull();
    expect(store.get()).toBeNull();
    svc.stop();
  });

  it('serves nothing from a stored report whose windows have reset', () => {
    const old: ClaudeUsage = {
      sevenDay: { usedPercentage: 9, resetsAt: Date.now() - 1 },
      fiveHour: null,
      at: 0,
    };
    const svc = new UsageService(memoryStore(old), () => undefined);
    expect(svc.current()).toBeNull();
    svc.stop();
  });
});

describe('resetLabel', () => {
  it('shows the time within a day, else the weekday too', () => {
    const at = NOW + 3 * DAY;
    const soon = resetLabel(NOW + 3600_000, NOW, 'en-US');
    expect(soon).toMatch(/^\d{2}:\d{2}( [AP]M)?$/);
    const later = resetLabel(at, NOW, 'en-US');
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(at);
    expect(later.startsWith(weekday)).toBe(true);
  });
});
