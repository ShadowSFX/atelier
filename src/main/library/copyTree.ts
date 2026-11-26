import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readlink, stat, symlink, utimes } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isInsidePath } from '@shared/launchers';
import { rebasePath } from '@shared/library';

/**
 * Copying a project to another drive (a rename can't cross volumes). Files keep their times (and, on Windows, their
 * attributes: CopyFile copies them); links are recreated as links — directory links as junctions, which need no
 * admin rights — re-pointed when they pointed inside the project (pnpm's node_modules).
 */

export interface TreeSize {
  files: number;
  bytes: number;
  /** The walk stopped at the limit: the numbers are a lower bound. */
  partial: boolean;
}

/** Files and bytes under `root` (links not followed), within `budgetMs`. */
export async function treeSize(
  root: string,
  budgetMs = 10_000,
  now: () => number = Date.now,
): Promise<TreeSize> {
  const deadline = now() + budgetMs;
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    if (now() > deadline) return { files, bytes, partial: true };
    const dir = stack.pop()!;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const p = join(dir, item.name);
      if (item.isDirectory()) stack.push(p);
      else if (item.isFile()) {
        files++;
        try {
          bytes += (await stat(p)).size;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return { files, bytes, partial: false };
}

export interface CopyOptions {
  onProgress: (bytes: number) => void;
  signal: AbortSignal;
}

/** Copies `src` to `dst` (which must not exist). Throws on the first error; the caller removes `dst`. */
export async function copyTree(src: string, dst: string, o: CopyOptions): Promise<TreeSize> {
  let files = 0;
  let bytes = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to);
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (o.signal.aborted) throw new Error('cancelled');
      const a = join(from, item.name);
      const b = join(to, item.name);
      if (item.isSymbolicLink()) {
        const target = await readlink(a);
        const absolute = isAbsolute(target) ? target : resolve(from, target);
        const isDirLink = await stat(a)
          .then((s) => s.isDirectory())
          .catch(() => false);
        const next = isInsidePath(absolute, src) ? rebasePath(absolute, src, dst) : absolute;
        if (isDirLink && process.platform === 'win32') await symlink(next, b, 'junction');
        else await symlink(isAbsolute(target) ? next : target, b, isDirLink ? 'dir' : 'file');
      } else if (item.isDirectory()) {
        await walk(a, b);
      } else if (item.isFile()) {
        await copyFile(a, b, constants.COPYFILE_EXCL);
        const s = await lstat(a);
        await utimes(b, s.atime, s.mtime).catch(() => undefined);
        files++;
        bytes += s.size;
        o.onProgress(bytes);
      }
    }
    const s = await lstat(from);
    await utimes(to, s.atime, s.mtime).catch(() => undefined);
  };
  await walk(src, dst);
  return { files, bytes, partial: false };
}
