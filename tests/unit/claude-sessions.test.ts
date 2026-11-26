import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SESSIONS_MAX } from '@shared/constants';
import { claudeProjectDirName } from '@shared/launchers';

vi.mock('../../src/main/log', () => ({ log: { warn() {}, error() {}, info() {} } }));
const { claudeConfigDir, listClaudeSessions } = await import('../../src/main/claude/sessions');

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
