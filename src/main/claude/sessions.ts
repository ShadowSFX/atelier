import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { SESSIONS_MAX, SESSIONS_READ_BYTES } from '@shared/constants';
import {
  claudeProjectDirName,
  isInsidePath,
  isSessionId,
  parseSessionHeadTail,
  type ClaudeSessionInfo,
} from '@shared/launchers';
import { log } from '../log';

/** Claude Code's data folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The first and last `bytes` of a file (the whole file when it is small). */
async function headAndTail(
  path: string,
  size: number,
  bytes: number,
): Promise<{ head: string; tail: string }> {
  const fh = await open(path, 'r');
  try {
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= bytes * 2) {
      const all = await read(0, size);
      return { head: all, tail: '' };
    }
    return { head: await read(0, bytes), tail: await read(size - bytes, bytes) };
  } finally {
    await fh.close();
  }
}

/**
 * Claude sessions that can be resumed from a project: transcripts whose working folder is the project's or one inside
 * it, newest first. Claude names a folder's transcript directory after its path (every non-alphanumeric → "-"), so
 * subfolders' directories start with the project's name plus "-"; a sibling such as `proj-old` matches that too and
 * is dropped by checking the transcript's own cwd. Only the head and tail of each transcript are read.
 */
export async function listClaudeSessions(
  projectPath: string,
  configDir = claudeConfigDir(),
): Promise<ClaudeSessionInfo[]> {
  const root = join(configDir, 'projects');
  // Windows paths reach Claude in any letter case ("desktop" and "Desktop" folders side by side): compare without it.
  const fold = (s: string) => (/^[a-z]:/i.test(projectPath) ? s.toLowerCase() : s);
  const prefix = fold(claudeProjectDirName(projectPath.replace(/[\\/]+$/, '')));
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && (fold(d.name) === prefix || fold(d.name).startsWith(prefix + '-')))
      .map((d) => join(root, d.name));
  } catch {
    return []; // Claude Code never ran here
  }

  const files: { path: string; id: string; mtime: number; size: number }[] = [];
  await Promise.all(
    dirs.map(async (dir) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((n) => n.endsWith('.jsonl') && isSessionId(basename(n, '.jsonl')))
          .map(async (n) => {
            const path = join(dir, n);
            try {
              const s = await stat(path);
              if (s.isFile() && s.size > 0)
                files.push({ path, id: basename(n, '.jsonl'), mtime: s.mtimeMs, size: s.size });
            } catch {
              /* deleted meanwhile */
            }
          }),
      );
    }),
  );
  files.sort((a, b) => b.mtime - a.mtime);

  const out: (ClaudeSessionInfo | null)[] = await Promise.all(
    files.slice(0, SESSIONS_MAX).map(async (f) => {
      try {
        const { head, tail } = await headAndTail(f.path, f.size, SESSIONS_READ_BYTES);
        const meta = parseSessionHeadTail(head, tail);
        // A session nobody typed into has nothing to resume; one from another folder is not this project's.
        // (A title only exists once the user typed something; the first prompt can lie past the head window.)
        if (!meta.title || !meta.cwd || !isInsidePath(meta.cwd, projectPath)) return null;
        return {
          id: f.id,
          title: meta.title,
          cwd: meta.cwd,
          gitBranch: meta.gitBranch,
          updatedAt: f.mtime,
          sizeBytes: f.size,
        };
      } catch (err) {
        log.warn('claude session unreadable', f.path, err);
        return null;
      }
    }),
  );
  // The same id in two folders (a moved transcript): keep the newest.
  const seen = new Set<string>();
  return out.filter((s): s is ClaudeSessionInfo => !!s && !seen.has(s.id) && !!seen.add(s.id));
}
