import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log';

/**
 * Writes a file atomically: temp file + fsync + rename, keeping the previous version as `.bak`.
 * A crash or power loss mid-write leaves either the old or the new file, never a truncated one.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch (err) {
      log.warn('backup failed', path, err);
    }
  }
  renameSync(tmp, path);
}

/** Reads JSON, falling back to the `.bak` copy when the main file is missing or corrupt. */
export function readJson(path: string): unknown {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (err) {
      if (existsSync(candidate)) log.warn('unreadable json', candidate, err);
    }
  }
  return undefined;
}

/**
 * A JSON document kept in memory and saved with a debounce. `parse` turns whatever is on disk (or undefined)
 * into a valid value: loading never throws.
 */
export class JsonStore<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    parse: (raw: unknown) => T,
    private readonly delayMs = 500,
  ) {
    this.value = parse(readJson(path));
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeFileAtomic(this.path, JSON.stringify(this.value, null, 2));
    } catch (err) {
      log.error('save failed', this.path, err);
    }
  }

  /** Saves now if a save is pending (used on quit). */
  flushPending(): void {
    if (this.timer) this.flush();
  }
}
