import { open, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitFacts, LocalFacts } from '@shared/library';
import { analyzeProbe, LANGUAGES, type FolderProbe } from '@shared/stack';

/**
 * The instant, local part of a project's description: manifests, README, file types and git, read with hard limits
 * (a folder of 200 000 files must not stall anything). Claude's description comes later (describe.ts).
 */

const MANIFESTS = [
  'package.json',
  'composer.json',
  'cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'pipfile',
  'setup.py',
  'go.mod',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pubspec.yaml',
];
/** Where monorepos keep their parts: their manifests count too. */
const PARTS = ['frontend', 'backend', 'client', 'server', 'web', 'app', 'api', 'src', 'packages', 'apps'];
const README = ['readme.md', 'readme', 'readme.txt', 'readme.rst', 'leeme.md'];
/** Never walked: dependencies, build output, caches, VCS. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.angular',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
  '.idea',
  '.vs',
  '.vscode',
  'vendor',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'library',
  'temp',
  '.godot',
  '.import',
  'logs',
]);
const MAX_MANIFEST = 256 * 1024;
const MAX_README = 16 * 1024;
const MAX_FILES = 4000;
const MAX_DIRS = 1200;
const MAX_DEPTH = 4;
const WALK_BUDGET_MS = 1500;

async function readHead(path: string, max: number): Promise<string | null> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function list(dir: string): Promise<{ name: string; dir: boolean; file: boolean }[]> {
  try {
    const items = await readdir(dir, { withFileTypes: true });
    return items.map((d) => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }));
  } catch {
    return [];
  }
}

/** Code files per extension, breadth first, within MAX_FILES / MAX_DIRS / MAX_DEPTH / WALK_BUDGET_MS. */
async function countExtensions(
  root: string,
  now: () => number,
  budgetMs: number,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const deadline = now() + budgetMs;
  let files = 0;
  let dirs = 0;
  let level: string[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (files >= MAX_FILES || dirs >= MAX_DIRS || now() > deadline) return counts;
      dirs++;
      for (const item of await list(dir)) {
        if (item.dir) {
          if (!SKIP.has(item.name.toLowerCase()) && !item.name.startsWith('.'))
            next.push(join(dir, item.name));
        } else if (item.file) {
          const dot = item.name.lastIndexOf('.');
          const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
          if (ext && LANGUAGES[ext]) {
            counts[ext] = (counts[ext] ?? 0) + 1;
            files++;
          }
        }
      }
    }
    level = next;
  }
  return counts;
}

/** Branch, worktree and last activity from the .git folder itself (no git process). */
export async function gitFacts(root: string): Promise<GitFacts | null> {
  const dotGit = join(root, '.git');
  let gitDir: string;
  let worktree = false;
  try {
    const s = await stat(dotGit);
    if (s.isDirectory()) gitDir = dotGit;
    else {
      // A linked worktree: ".git" is a file "gitdir: <path>".
      const text = (await readFile(dotGit, 'utf8')).trim();
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return null;
      gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(root, m[1]!);
      worktree = true;
    }
  } catch {
    return null;
  }
  let branch: string | null = null;
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    branch = m ? m[1]! : head.slice(0, 7) || null;
  } catch {
    /* unreadable HEAD */
  }
  let lastCommitAt: number | null = null;
  for (const f of [join(gitDir, 'logs', 'HEAD'), join(gitDir, 'HEAD')]) {
    try {
      lastCommitAt = (await stat(f)).mtimeMs;
      break;
    } catch {
      /* try the next one */
    }
  }
  return { branch, worktree, lastCommitAt };
}

/** Reads what the folder says about itself. Never throws: an unreadable folder gives empty facts. */
export async function analyzeFolder(
  root: string,
  now: () => number = Date.now,
  budgetMs = WALK_BUDGET_MS,
): Promise<LocalFacts> {
  const top = await list(root);
  const lower = new Map(top.map((t) => [t.name.toLowerCase(), t]));
  const manifests: Record<string, string> = {};
  await Promise.all([
    ...MANIFESTS.filter((m) => lower.get(m)?.file).map(async (m) => {
      const text = await readHead(join(root, lower.get(m)!.name), MAX_MANIFEST);
      if (text !== null) manifests[m] = text;
    }),
    ...PARTS.filter((p) => lower.get(p)?.dir).map(async (p) => {
      const sub = lower.get(p)!.name;
      for (const item of await list(join(root, sub))) {
        const m = item.name.toLowerCase();
        if (item.file && MANIFESTS.includes(m)) {
          const text = await readHead(join(root, sub, item.name), MAX_MANIFEST);
          if (text !== null) manifests[`${p}/${m}`] = text;
        }
      }
    }),
  ]);
  const readmeName = README.find((r) => lower.get(r)?.file);
  const readme = readmeName ? await readHead(join(root, lower.get(readmeName)!.name), MAX_README) : null;

  const probe: FolderProbe = {
    names: top.map((t) => t.name),
    dirs: top.filter((t) => t.dir).map((t) => t.name),
    manifests,
    extensions: await countExtensions(root, now, budgetMs),
    readme,
  };
  const result = analyzeProbe(probe);

  let modifiedAt: number | null = null;
  await Promise.all(
    top.slice(0, 200).map(async (t) => {
      try {
        const m = (await stat(join(root, t.name))).mtimeMs;
        if (modifiedAt === null || m > modifiedAt) modifiedAt = m;
      } catch {
        /* vanished */
      }
    }),
  );

  return { ...result, git: await gitFacts(root), modifiedAt, analyzedAt: now() };
}
