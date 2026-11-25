import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_MAX_CHARS } from '@shared/constants';
import { log } from '../log';
import { writeFileAtomic } from './JsonStore';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Keeps the end of an oversized snapshot, cut at a line start (never inside an escape sequence's line). */
function cap(text: string): string {
  if (text.length <= SNAPSHOT_MAX_CHARS) return text;
  const from = text.indexOf('\n', text.length - SNAPSHOT_MAX_CHARS);
  return from < 0 ? '' : text.slice(from + 1);
}

/** What each terminal showed when it was last saved, restored under the new shell on the next start. */
export class SnapshotStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string | null {
    return ID.test(id) ? join(this.dir, `${id}.txt`) : null;
  }

  read(id: string): string | null {
    const f = this.file(id);
    if (!f) return null;
    try {
      return cap(readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  }

  write(id: string, data: string): void {
    const f = this.file(id);
    if (!f) return;
    try {
      writeFileAtomic(f, cap(data));
    } catch (err) {
      log.warn('snapshot write failed', id, err);
    }
  }

  delete(id: string): void {
    const f = this.file(id);
    if (!f) return;
    rmSync(f, { force: true });
    rmSync(`${f}.bak`, { force: true });
  }

  /** Removes snapshots of terminals that no longer exist. */
  prune(keep: Set<string>): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.replace(/\.txt(\.bak|\.tmp)?$/, '');
      if (!keep.has(id)) rmSync(join(this.dir, name), { force: true });
    }
  }
}
