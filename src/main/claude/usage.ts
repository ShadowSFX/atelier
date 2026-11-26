import { liveUsage, nextReset, type ClaudeUsage } from '@shared/usage';

/** Longest single wait (setTimeout overflows past ~24.8 days; a day keeps the clock honest after sleep). */
const MAX_WAIT_MS = 24 * 3600_000;
const SAME_REPORT_MS = 60_000;

interface Store {
  get(): ClaudeUsage | null;
  set(value: ClaudeUsage | null): void;
  flushPending(): void;
}

/**
 * The Claude plan's usage limits, as the latest statusLine report from any Atelier terminal said (the account's,
 * not a project's: with two accounts in two terminals, the newest report wins). Kept on disk until the windows
 * reset, so the status bar has a figure before the next Claude reply. A window is dropped when its reset passes.
 */
export class UsageService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly emit: (u: ClaudeUsage | null) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.schedule();
  }

  current(): ClaudeUsage | null {
    return liveUsage(this.store.get(), this.now());
  }

  update(u: ClaudeUsage): void {
    const prev = this.current();
    // Either window can be missing from a report; Claude only drops one when it resets, and so does `liveUsage`:
    // a window the report doesn't carry keeps its last figure.
    const next = liveUsage(
      {
        sevenDay: u.sevenDay ?? prev?.sevenDay ?? null,
        fiveHour: u.fiveHour ?? prev?.fiveHour ?? null,
        at: this.now(),
      },
      this.now(),
    );
    if (!next) return;
    // Claude reruns its statusLine every few hundred ms while it works: the same figures are saved and sent at
    // most once a minute (enough for the tooltip's "updated" time).
    const same =
      prev &&
      JSON.stringify([prev.sevenDay, prev.fiveHour]) === JSON.stringify([next.sevenDay, next.fiveHour]);
    if (same && next.at - prev.at < SAME_REPORT_MS) return;
    this.store.set(next);
    this.emit(next);
    this.schedule();
  }

  flushPending(): void {
    this.store.flushPending();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.stop();
    const at = nextReset(this.current());
    if (at === null) return;
    const wait = Math.min(MAX_WAIT_MS, Math.max(1000, at - this.now() + 500));
    this.timer = setTimeout(() => this.expire(), wait);
    this.timer.unref?.();
  }

  private expire(): void {
    const before = this.store.get();
    const live = this.current();
    if (JSON.stringify(live) !== JSON.stringify(before)) {
      this.store.set(live);
      this.emit(live);
    }
    this.schedule();
  }
}
