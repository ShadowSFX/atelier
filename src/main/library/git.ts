import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';

/**
 * Git worktrees store absolute paths both ways (the worktree's .git file → the main repo's .git/worktrees/<name>,
 * and that folder's "gitdir" → the worktree). Moving either side breaks the link until `git worktree repair`
 * rewrites them. Git is only needed when the project has worktrees.
 */

function run(git: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      git,
      args,
      { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    ),
  );
}

/** The folder is a linked worktree (its .git is a file). */
export async function isWorktree(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, '.git'))).isFile();
  } catch {
    return false;
  }
}

/** Linked worktrees of the repository in `root` (not the main one), read from .git/worktrees/<name>/gitdir. */
export async function linkedWorktrees(root: string): Promise<string[]> {
  const dir = join(root, '.git', 'worktrees');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    try {
      const gitdir = (await readFile(join(dir, n, 'gitdir'), 'utf8')).trim();
      // gitdir points at the worktree's .git file.
      out.push(gitdir.replace(/[\\/]\.git$/, '').replace(/\//g, process.platform === 'win32' ? '\\' : '/'));
    } catch {
      /* a pruned entry */
    }
  }
  return out;
}

/** After a move: repairs the links of a moved worktree, or of a moved repository with its worktrees. */
export async function repairWorktrees(
  git: string | null,
  root: string,
  worktrees: string[],
): Promise<boolean> {
  if (!git) return false;
  try {
    await run(git, ['worktree', 'repair', ...worktrees], root);
    return true;
  } catch (err) {
    log.warn('git worktree repair failed', root, err);
    return false;
  }
}
