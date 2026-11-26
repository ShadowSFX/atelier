import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { claudeProjectDirName } from '@shared/launchers';
import { newEntry, type Library } from '@shared/library';
import type { MoveProgress } from '@shared/move';
import type { Workspace } from '@shared/workspace';

vi.mock('../../src/main/log', () => ({ log: { warn() {}, error() {}, info() {} } }));
const { claudeDirsFor, migrateClaudeDirs, migrateClaudeJson } =
  await import('../../src/main/library/claudeData');
const { copyTree, treeSize } = await import('../../src/main/library/copyTree');
const { LibraryService } = await import('../../src/main/library/LibraryService');
const { Mover } = await import('../../src/main/library/move');

const base = mkdtempSync(join(tmpdir(), 'atelier-library-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const d = join(base, name + '-' + ++n);
  mkdirSync(d, { recursive: true });
  return d;
};

function transcript(config: string, dirName: string, cwd: string): string {
  const dir = join(config, 'projects', dirName);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, '00000000-0000-4000-8000-00000000000' + (++n % 10) + '.jsonl');
  writeFileSync(
    f,
    [JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }), 'not json', ''].join('\n'),
  );
  return f;
}

describe('Claude data follows a moved project', () => {
  it('matches folders by name and, for suffixed ones, by the cwd inside', async () => {
    const config = fresh('claude');
    const root = fresh('work');
    const project = join(root, 'apex');
    const enc = claudeProjectDirName(project);
    transcript(config, enc, project);
    transcript(config, enc + '-backend', join(project, 'backend')); // a subfolder: belongs
    transcript(config, enc + '-old', join(root, 'apex-old')); // a sibling that shares the prefix: doesn't
    mkdirSync(join(config, 'projects', enc.toLowerCase() === enc ? enc + '-x' : enc.toLowerCase()), {
      recursive: true,
    });
    const dest = join(root, 'moved', 'apex');
    const dirs = await claudeDirsFor(config, project, dest);
    const names = dirs.map((d) => d.name).sort();
    expect(names).toContain(enc);
    expect(names).toContain(enc + '-backend');
    expect(names).not.toContain(enc + '-old');

    const r = await migrateClaudeDirs(
      config,
      dirs,
      project,
      dest,
      join(config, 'projects', '.atelier-backup', 'm1'),
    );
    expect(r.notes).toEqual([]);
    const target = join(config, 'projects', claudeProjectDirName(dest) + '-backend');
    const file = readdirSync(target).find((f) => f.endsWith('.jsonl'))!;
    const lines = readFileSync(join(target, file), 'utf8').split('\n');
    expect(JSON.parse(lines[0]!).cwd).toBe(join(dest, 'backend'));
    expect(lines[1]).toBe('not json'); // kept as it was
    expect(existsSync(join(config, 'projects', enc + '-backend'))).toBe(false); // put aside in the backup
    expect(existsSync(join(config, 'projects', enc + '-old'))).toBe(true);
  });

  it('copies ~/.claude.json settings to the new path and keeps the old keys', async () => {
    const dir = fresh('json');
    const file = join(dir, '.claude.json');
    const project = process.platform === 'win32' ? 'C:\\w\\apex' : '/w/apex';
    const moved = process.platform === 'win32' ? 'D:\\p\\apex' : '/p/apex';
    const fwd = process.platform === 'win32' ? 'C:/w/apex/sub' : '/w/apex/sub';
    writeFileSync(
      file,
      JSON.stringify({ projects: { [project]: { trust: true }, [fwd]: { a: 1 }, other: { b: 2 } }, x: 1 }),
    );
    expect(await migrateClaudeJson(file, project, moved)).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown>; x: number };
    expect(json.projects[moved]).toEqual({ trust: true });
    expect(json.projects[process.platform === 'win32' ? 'D:/p/apex/sub' : '/p/apex/sub']).toEqual({ a: 1 });
    expect(json.projects[project]).toEqual({ trust: true });
    expect(json.x).toBe(1);
  });
});

describe('copying to another drive', () => {
  it('copies every file and the tree size matches', async () => {
    const src = fresh('src');
    mkdirSync(join(src, 'a', 'b'), { recursive: true });
    writeFileSync(join(src, 'a', 'b', 'x.txt'), 'hello');
    writeFileSync(join(src, 'y.bin'), Buffer.alloc(1000));
    const dst = join(fresh('dst'), 'copy');
    const seen: number[] = [];
    const copied = await copyTree(src, dst, {
      onProgress: (b) => seen.push(b),
      signal: new AbortController().signal,
    });
    const before = await treeSize(src);
    const after = await treeSize(dst);
    expect(copied.files).toBe(2);
    expect(after).toEqual(before);
    expect(readFileSync(join(dst, 'a', 'b', 'x.txt'), 'utf8')).toBe('hello');
    expect(seen.at(-1)).toBe(1005);
  });
});

function harness(opts: { busy?: string[]; workspace?: Workspace } = {}) {
  const root = fresh('move');
  const userData = fresh('data');
  const config = fresh('cfg');
  const source = join(root, 'apex');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"dependencies":{"react":"19"}}');
  let ws: Workspace = opts.workspace ?? {
    version: 1,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'apex',
        path: source,
        color: null,
        terminals: [{ id: 't1', name: 'dev', color: null, profileId: '', lastCwd: join(source, 'src') }],
        layout: { columns: [{ terminalId: 't1', weight: 1 }], active: 0 },
      },
    ],
  };
  const events: string[] = [];
  const progress: MoveProgress[] = [];
  const library = new LibraryService({
    file: join(userData, 'library.json'),
    workspace: () => ws,
    emit: () => undefined,
    claudeExe: () => null,
    runner: () => async () => '',
    lang: () => 'en',
  });
  const mover: InstanceType<typeof Mover> = new Mover({
    library,
    workspace: { get: () => ws, set: (w) => (ws = w) },
    journalFile: join(userData, 'move-journal.json'),
    claudeConfigDir: config,
    claudeJson: join(config, '.claude.json'),
    protectedPaths: () => [userData],
    running: (id) => id === 't1',
    busy: () => opts.busy ?? [],
    foreground: () => new Map([['t1', 'node']]),
    claudeState: () => null,
    kill: (id) => events.push('kill ' + id),
    settled: async () => undefined,
    stopBackground: async () => undefined,
    git: () => null,
    progress: (p) => progress.push(p),
    // The renderer's side: ack right away.
    suspend: (id, ids) => {
      events.push('suspend ' + ids.join(','));
      queueMicrotask(() => mover.ack(id, 'suspended'));
    },
    committed: (id, from, to, ids) => {
      events.push('committed ' + ids.join(','));
      queueMicrotask(() => mover.ack(id, 'applied'));
    },
    aborted: (_id, ids) => events.push('aborted ' + ids.join(',')),
  });
  const done = () =>
    new Promise<MoveProgress>((resolve) => {
      const timer = setInterval(() => {
        const last = progress.at(-1);
        if (last && ['done', 'failed', 'cancelled'].includes(last.phase)) {
          clearInterval(timer);
          resolve(last);
        }
      }, 20);
    });
  return { root, source, library, mover, events, progress, done, ws: () => ws, userData };
}

describe('moving a project', () => {
  it('stops its terminals, moves the folder, rebases everything and starts them again', async () => {
    const h = harness();
    const dest = join(h.root, 'Projects', 'apex');
    const plan = await h.mover.plan('p1', dest);
    expect(plan.blockers).toEqual([]);
    expect(plan.terminals.map((x) => [x.id, x.foreground])).toEqual([['t1', 'node']]);
    expect(h.mover.start(plan.id, false)).toBe(true);
    const end = await h.done();
    expect(end.phase).toBe('done');
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(existsSync(h.source)).toBe(false);
    expect(h.events).toEqual(['suspend t1', 'kill t1', 'committed t1']);
    expect(h.library.entry('p1')!.path).toBe(dest);
    expect(h.ws().projects[0]!.path).toBe(dest);
    expect(h.ws().projects[0]!.terminals[0]!.lastCwd).toBe(join(dest, 'src'));
    expect(existsSync(join(h.userData, 'move-journal.json'))).toBe(false);
  });

  it('refuses a destination that exists and undoes nothing it did not do', async () => {
    const h = harness();
    const dest = join(h.root, 'taken');
    mkdirSync(dest);
    const plan = await h.mover.plan('p1', dest);
    expect(plan.blockers).toContain('dest-exists');
    expect(h.mover.start(plan.id, false)).toBe(false);
    expect(existsSync(h.source)).toBe(true);
    expect(h.events).toEqual([]);
  });

  it('a workspace saved before the renderer applied the move is rebased', async () => {
    const h = harness();
    const dest = join(h.root, 'P2', 'apex');
    const stale = h.ws();
    const plan = await h.mover.plan('p1', dest);
    h.mover.start(plan.id, false);
    await h.done();
    // After the ack nothing is rebased any more; before it, a stale save would have been.
    expect(h.mover.rebaseIncoming(stale).projects[0]!.path).toBe(h.source);
  });

  it('finishes an interrupted rename on the next start', async () => {
    const h = harness();
    const dest = join(h.root, 'after-crash');
    // As if Atelier died right after the rename: the journal says "moving", the folder is already there.
    const { renameSync } = await import('node:fs');
    renameSync(h.source, dest);
    writeFileSync(
      join(h.userData, 'move-journal.json'),
      JSON.stringify({
        id: 'm1',
        entryId: 'p1',
        source: h.source,
        destination: dest,
        mode: 'rename',
        phase: 'moving',
        createdDestination: false,
        trash: null,
      }),
    );
    await h.mover.recover();
    expect(h.library.entry('p1')!.path).toBe(dest);
    expect(h.ws().projects[0]!.path).toBe(dest);
    expect(existsSync(join(h.userData, 'move-journal.json'))).toBe(false);
  });
});

describe('library service', () => {
  it('migrates open projects on the first start and remembers closed setups', () => {
    const h = harness();
    const lib: Library = h.library.get();
    expect(lib.entries.map((e) => e.id)).toEqual(['p1']);
    expect(lib.entries[0]!.job.state).toBe('queued');
    h.library.apply({
      op: 'remember',
      id: 'p1',
      remembered: { terminals: h.ws().projects[0]!.terminals, layout: h.ws().projects[0]!.layout },
    });
    expect(h.library.rememberedTerminalIds()).toEqual(['t1']);
    // Open again (the workspace has it): the remembered copy goes.
    h.library.reconcile(h.ws());
    expect(h.library.rememberedTerminalIds()).toEqual([]);
  });

  it('describes queued projects with Claude, one at a time, through stdin', async () => {
    const dir = fresh('desc');
    const project = join(dir, 'app');
    mkdirSync(project);
    const calls: { args: string[]; input?: string; cwd?: string }[] = [];
    const svc = new LibraryService({
      file: join(dir, 'library.json'),
      workspace: () => ({ version: 1, projects: [], activeProjectId: null }),
      emit: () => undefined,
      claudeExe: () => 'claude',
      runner: () => async (args, _t, o) => {
        calls.push({ args, input: o?.input, cwd: o?.cwd });
        return JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"description":"A small app.","stack":["TypeScript"],"kind":"app"}',
        });
      },
      lang: () => 'en',
    });
    const [e] = svc.add([project]);
    // The local analysis lands first.
    await vi.waitFor(() => expect(svc.entry(e!.id)!.local).not.toBeNull(), { timeout: 4000 });
    svc.start();
    await vi.waitFor(() => expect(svc.entry(e!.id)!.job.state).toBe('done'), { timeout: 8000 });
    expect(svc.entry(e!.id)!.claude).toMatchObject({
      text: 'A small app.',
      stack: ['TypeScript'],
      kind: 'app',
      model: 'opus',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(project);
    expect(calls[0]!.input).toContain('JSON');
    expect(calls[0]!.args).not.toContain(calls[0]!.input);
    svc.stop();
  });

  it('marks jobs unavailable without Claude Code', async () => {
    const dir = fresh('noclaude');
    mkdirSync(join(dir, 'x'));
    const svc = new LibraryService({
      file: join(dir, 'library.json'),
      workspace: () => ({ version: 1, projects: [], activeProjectId: null }),
      emit: () => undefined,
      claudeExe: () => null,
      runner: () => async () => '',
      lang: () => 'en',
    });
    const [e] = svc.add([join(dir, 'x')]);
    svc.start();
    await vi.waitFor(() => expect(svc.entry(e!.id)!.job.state).toBe('unavailable'), { timeout: 8000 });
    svc.stop();
    expect(newEntry('a', 'b', 0).missing).toBe(false);
  });
});
