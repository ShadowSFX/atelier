import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { claudeProjectDirName, isInsidePath } from '@shared/launchers';
import { rebasePath } from '@shared/library';
import { pathIdentity } from '@shared/workspace';
import { log } from '../log';

/**
 * Claude Code keeps each working folder's transcripts and memory in ~/.claude/projects/<encoded path>, and per-folder
 * settings (trust, allowed tools) under "projects" in ~/.claude.json. When a project moves, both follow it, so
 * "Resume a Claude session" and the project's memory keep working.
 *
 * Folder names lose information (every non-alphanumeric becomes "-", and letter case is whatever the path had):
 * "apex" also prefixes "apex-backend", a sibling. A folder counts as the project's only when it is the exact name, or
 * when its transcripts say they ran inside the project.
 */

/** How many transcripts are read to tell whose a folder is. */
const PROBE_FILES = 5;
const PROBE_BYTES = 64 * 1024;

export interface ClaudeDir {
  name: string;
  /** The folder name after the move. */
  target: string;
}

async function transcriptCwds(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).slice(0, PROBE_FILES);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    try {
      const text = (await readFile(join(dir, n), 'utf8')).slice(0, PROBE_BYTES);
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (m) out.push(JSON.parse('"' + m[1] + '"') as string);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** The ~/.claude/projects folders that belong to `oldPath` (it and everything inside it). */
export async function claudeDirsFor(
  configDir: string,
  oldPath: string,
  newPath: string,
): Promise<ClaudeDir[]> {
  const root = join(configDir, 'projects');
  const oldEnc = claudeProjectDirName(oldPath.replace(/[\\/]+$/, ''));
  const newEnc = claudeProjectDirName(newPath.replace(/[\\/]+$/, ''));
  const windows = /^[a-z]:/i.test(oldPath);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: ClaudeDir[] = [];
  for (const name of names) {
    const head = name.slice(0, oldEnc.length);
    if (!same(head, oldEnc)) continue;
    const rest = name.slice(oldEnc.length);
    if (rest !== '' && !rest.startsWith('-')) continue;
    if (rest !== '') {
      const cwds = await transcriptCwds(join(root, name));
      if (cwds.length === 0 || !cwds.some((c) => isInsidePath(c, oldPath))) continue;
    }
    out.push({ name, target: newEnc + rest });
  }
  return out;
}

/** Copies a transcript, pointing its `cwd` fields at the new folder. Lines that aren't JSON are kept as they are. */
async function rewriteTranscript(from: string, to: string, oldPath: string, newPath: string): Promise<void> {
  const input = createReadStream(from, { encoding: 'utf8' });
  const output = createWriteStream(to, { encoding: 'utf8', flags: 'wx' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let out = line;
      if (line.includes('"cwd"')) {
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (typeof o.cwd === 'string' && isInsidePath(o.cwd, oldPath)) {
            o.cwd = rebasePath(o.cwd, oldPath, newPath);
            out = JSON.stringify(o);
          }
        } catch {
          /* not JSON: verbatim */
        }
      }
      if (!output.write(out + '\n')) await once(output, 'drain');
    }
  } finally {
    output.end();
    await once(output, 'close').catch(() => undefined);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeMigration {
  moved: number;
  /** Where the original folders were put aside (deleted once the move is done). */
  backup: string | null;
  notes: string[];
}

/**
 * Moves the project's Claude folders to their new names: a new folder is written (transcripts rewritten, everything
 * else copied), then the old one is put aside in `backupDir`. A target that already exists is merged into (files it
 * has are kept). Errors are reported in `notes`, never thrown: the project itself has already moved.
 */
export async function migrateClaudeDirs(
  configDir: string,
  dirs: ClaudeDir[],
  oldPath: string,
  newPath: string,
  backupDir: string,
): Promise<ClaudeMigration> {
  const root = join(configDir, 'projects');
  const notes: string[] = [];
  let moved = 0;
  let backupUsed = false;
  for (const d of dirs) {
    if (d.name === d.target) continue;
    const from = join(root, d.name);
    const to = join(root, d.target);
    // Only the letter case differs and the file system ignores case: the folder is already right.
    if (d.name.toLowerCase() === d.target.toLowerCase() && process.platform === 'win32') continue;
    try {
      await mkdir(to, { recursive: true });
      for (const item of await readdir(from, { withFileTypes: true })) {
        const src = join(from, item.name);
        const dst = join(to, item.name);
        if (await exists(dst)) continue;
        if (item.isFile() && item.name.endsWith('.jsonl'))
          await rewriteTranscript(src, dst, oldPath, newPath);
        else await cp(src, dst, { recursive: true, errorOnExist: false, force: false });
      }
      await mkdir(backupDir, { recursive: true });
      await rename(from, join(backupDir, d.name));
      backupUsed = true;
      moved++;
    } catch (err) {
      log.warn('claude data migration', d.name, err);
      notes.push(d.name);
    }
  }
  return { moved, backup: backupUsed ? backupDir : null, notes };
}

/**
 * ~/.claude.json keeps settings per folder under "projects" (several spellings of one folder can exist). Each key
 * inside the old folder gets a copy under the new path; the old keys stay (harmless, and nothing is lost if Claude
 * rewrites the file meanwhile). The write is skipped when the file changed while it was being read.
 */
export async function migrateClaudeJson(file: string, oldPath: string, newPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let before: number;
    let json: Record<string, unknown>;
    try {
      before = (await stat(file)).mtimeMs;
      json = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return false; // no file, or not readable JSON: nothing to carry over
    }
    const projects = json.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return false;
    const map = projects as Record<string, unknown>;
    const additions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(map)) {
      const native = key.replace(/\//g, '\\');
      const windows = /^[a-z]:\\/i.test(native);
      const probe = windows ? native : key;
      if (!isInsidePath(probe, oldPath)) continue;
      let next = rebasePath(probe, oldPath, newPath);
      if (windows && key.includes('/')) next = next.replace(/\\/g, '/');
      if (
        !Object.keys(map).some(
          (k) => pathIdentity(k.replace(/\//g, '\\')) === pathIdentity(next.replace(/\//g, '\\')),
        )
      )
        additions[next] = value;
    }
    if (Object.keys(additions).length === 0) return true;
    json.projects = { ...map, ...additions };
    try {
      if ((await stat(file)).mtimeMs !== before) continue; // Claude wrote it meanwhile: read again
      const tmp = file + '.atelier-tmp';
      await writeFile(tmp, JSON.stringify(json, null, 2), 'utf8');
      if ((await stat(file)).mtimeMs !== before) {
        await rm(tmp, { force: true });
        continue;
      }
      await rename(tmp, file);
      return true;
    } catch (err) {
      log.warn('claude.json migration', err);
      return false;
    }
  }
  return false;
}
