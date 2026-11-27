import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SESSIONS_MAX } from '@shared/constants';
import { claudeProjectDirName } from '@shared/launchers';

vi.mock('../../src/main/log', () => ({ log: { warn() {}, error() {}, info() {} } }));
const { claudeConfigDir, hasConversation, listClaudeSessions } =
  await import('../../src/main/claude/sessions');

const base = mkdtempSync(join(tmpdir(), 'atelier-sessions-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const project = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
const sep = process.platform === 'win32' ? '\\' : '/';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** Writes a transcript for `cwd`, last modified `age` seconds ago. */
function transcript(config: string, cwd: string, prompt: string | null, age: number, extra = ''): string {
  const id = uuid();
  const dir = join(config, 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id })];
  if (prompt)
    lines.push(JSON.stringify({ type: 'user', cwd, gitBranch: 'main', message: { content: prompt } }));
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n' + extra);
  const t = Date.now() / 1000 - age;
  utimesSync(file, t, t);
  return id;
}

describe('listClaudeSessions', () => {
  it("lists the project's and its subfolders' sessions, newest first", async () => {
    const config = join(base, 'a');
    const older = transcript(config, project, 'first task', 300);
    const newer = transcript(config, project, 'second task', 10);
    const sub = transcript(config, `${project}${sep}packages${sep}web`, 'web task', 100);
    transcript(config, `${project}-old`, 'sibling task', 5); // a sibling folder whose name starts the same
    transcript(config, project, null, 1); // opened and never used
    writeFileSync(join(config, 'projects', claudeProjectDirName(project), 'notes.jsonl'), 'x'); // not a session

    const list = await listClaudeSessions(project, config);
    expect(list.map((s) => s.id)).toEqual([newer, sub, older]);
    expect(list[0]).toMatchObject({ title: 'second task', cwd: project, gitBranch: 'main' });
    expect(list[1]!.cwd).toBe(`${project}${sep}packages${sep}web`);
  });

  it('reads the title from the end of a big transcript', async () => {
    const config = join(base, 'b');
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'y'.repeat(300_000) } }) + '\n';
    const id = transcript(
      config,
      project,
      'long session',
      1,
      filler + JSON.stringify({ type: 'ai-title', aiTitle: 'Big one' }) + '\n',
    );
    const list = await listClaudeSessions(project, config);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: 'Big one' });
  });

  it('caps how many transcripts it reads', async () => {
    const config = join(base, 'c');
    for (let i = 0; i < SESSIONS_MAX + 5; i++) transcript(config, project, `task ${i}`, i);
    expect(await listClaudeSessions(project, config)).toHaveLength(SESSIONS_MAX);
  });

  it('returns nothing when Claude Code never ran', async () => {
    expect(await listClaudeSessions(project, join(base, 'missing'))).toEqual([]);
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg');
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });
});

describe('hasConversation', () => {
  const config = join(base, 'conv');
  /** Writes `<config>/projects/<dir>/<id>.jsonl` with these lines. */
  const write = (dir: string, id: string, lines: unknown[]) => {
    mkdirSync(join(config, 'projects', dir), { recursive: true });
    writeFileSync(
      join(config, 'projects', dir, `${id}.jsonl`),
      lines.map((l) => JSON.stringify(l) + '\n').join(''),
    );
  };

  it('is true once the transcript holds a message, in whichever project folder', async () => {
    const used = transcript(config, project, 'a task', 1);
    expect(await hasConversation(used, config)).toBe(true);
    const moved = uuid();
    write('elsewhere', moved, [{ type: 'assistant', message: { content: 'hi' } }]);
    expect(await hasConversation(moved, config)).toBe(true);
  });

  it('finds the message after a big first line', async () => {
    const id = uuid();
    write('big', id, [
      { type: 'file-history-snapshot', snapshot: { note: 'z'.repeat(500_000), type: 'user' } },
      { type: 'user', message: { content: 'go' } },
    ]);
    expect(await hasConversation(id, config)).toBe(true);
  });

  it('is false for a session nobody typed into', async () => {
    expect(await hasConversation(uuid(), config)).toBe(false); // no transcript at all
    const titled = uuid();
    write('titled', titled, [
      { type: 'ai-title', aiTitle: 'Latest fixes', sessionId: titled },
      { type: 'agent-name', agentName: 'Latest fixes', sessionId: titled },
    ]);
    expect(await hasConversation(titled, config)).toBe(false);
    const blank = uuid();
    write('blank', blank, []);
    expect(await hasConversation(blank, config)).toBe(false);
    expect(await hasConversation(transcript(config, project, null, 1), config)).toBe(false); // opened, never used
  });

  it('is false when Claude Code never ran, null for an id that is not one', async () => {
    expect(await hasConversation(uuid(), join(base, 'never'))).toBe(false);
    expect(await hasConversation('../../etc/passwd', config)).toBeNull();
  });
});
