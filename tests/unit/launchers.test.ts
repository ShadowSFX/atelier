import { describe, expect, it } from 'vitest';
import { STRINGS } from '@shared/i18n';
import {
  CODE_MODE_ENV,
  claudeCommand,
  claudeLaunchEnv,
  claudeProjectDirName,
  filterLaunchEnv,
  isInsidePath,
  isSessionId,
  LAUNCHERS,
  parseBackgroundSessions,
  parseSessionHeadTail,
} from '@shared/launchers';
import { parseWorkspace } from '@shared/workspace';

const ID = '4574a299-53dc-4ef0-a013-778da5087089';
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('launchers', () => {
  it('every launcher has its strings, and only Claude ones start Claude', () => {
    for (const l of LAUNCHERS) {
      expect(STRINGS[l.label]).toBeDefined();
      if (l.name) expect(STRINGS[l.name]).toBeDefined();
    }
    expect(LAUNCHERS.map((l) => l.id)).toEqual(['shell', 'claude', 'claude-code-mode']);
    expect(LAUNCHERS.find((l) => l.id === 'claude-code-mode')!.claude).toEqual({ codeMode: true });
    expect(LAUNCHERS.find((l) => l.id === 'shell')!.claude).toBeUndefined();
  });

  it('types only a validated session id', () => {
    expect(claudeCommand({ sessionId: null })).toBe('claude');
    expect(claudeCommand({ sessionId: ID })).toBe(`claude --resume ${ID}`);
    expect(claudeCommand({ sessionId: `${ID}; rm -rf ~` })).toBe('claude');
    expect(claudeCommand({ sessionId: '$(whoami)' })).toBe('claude');
    expect(isSessionId(ID.toUpperCase())).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });

  it('attaches to a background session only by a hex short id', () => {
    expect(claudeCommand({ sessionId: ID }, 'a86a9a2f')).toBe('claude attach a86a9a2f');
    expect(claudeCommand({ sessionId: ID }, null)).toBe(`claude --resume ${ID}`);
    expect(claudeCommand({ sessionId: ID }, 'a86a; rm')).toBe(`claude --resume ${ID}`);
    expect(claudeCommand({ sessionId: ID }, '$(id)')).toBe(`claude --resume ${ID}`);
  });

  it('reads the running background sessions from claude agents --json', () => {
    const other = '57067a84-55c6-47d7-b626-711d2152d80e';
    const json = JSON.stringify([
      // stopped: still listed, no pid
      { id: '57067a84', cwd: 'C:\\x', kind: 'background', sessionId: other, state: 'blocked' },
      { pid: 35716, id: 'a86a9a2f', kind: 'background', sessionId: ID, status: 'idle', state: 'done' },
      { pid: 2, id: 'b1b2b3b4', kind: 'background', sessionId: other, status: 'busy' },
      { pid: 10528, kind: 'interactive', sessionId: ID, status: 'busy' },
      { pid: 3, id: 'x; rm -rf', kind: 'background', sessionId: ID, status: 'idle' },
      { pid: 4, id: 'c1c2c3c4', kind: 'background', sessionId: 'nope', status: 'idle' },
      { pid: -1, id: 'd1d2d3d4', kind: 'background', sessionId: ID, status: 'idle' },
      null,
      'text',
    ]);
    expect(parseBackgroundSessions(json)).toEqual([
      { id: 'a86a9a2f', sessionId: ID, pid: 35716, idle: true },
      { id: 'b1b2b3b4', sessionId: other, pid: 2, idle: false },
    ]);
    expect(parseBackgroundSessions('not json')).toEqual([]);
    expect(parseBackgroundSessions('{"id":"a86a9a2f"}')).toEqual([]);
    expect(parseBackgroundSessions('')).toEqual([]);
  });

  it('sets Code Mode only for Code Mode, and lets only allowed variables through', () => {
    expect(claudeLaunchEnv({ codeMode: false })).toEqual({});
    expect(claudeLaunchEnv({ codeMode: true })).toEqual({ [CODE_MODE_ENV]: '1' });
    expect(filterLaunchEnv({ [CODE_MODE_ENV]: '1', PATH: 'C:\\evil', NODE_OPTIONS: '--require x' })).toEqual({
      [CODE_MODE_ENV]: '1',
    });
    expect(filterLaunchEnv({ [CODE_MODE_ENV]: '1\n& calc' })).toEqual({});
    expect(filterLaunchEnv({ [CODE_MODE_ENV]: 1 })).toEqual({});
    expect(filterLaunchEnv(null)).toEqual({});
    expect(filterLaunchEnv('x')).toEqual({});
  });
});

describe('Claude session files', () => {
  it("names a folder's transcript directory like Claude Code", () => {
    expect(claudeProjectDirName('C:\\Users\\Relic\\Desktop\\Atelier')).toBe('C--Users-Relic-Desktop-Atelier');
    expect(claudeProjectDirName('C:\\Users\\Relic\\Desktop\\Pangya-Relic\\.claude\\worktrees')).toBe(
      'C--Users-Relic-Desktop-Pangya-Relic--claude-worktrees',
    );
    expect(claudeProjectDirName('/home/me/my_app')).toBe('-home-me-my-app');
  });

  it('tells a folder inside the project from a sibling', () => {
    const root = 'C:\\Users\\Relic\\Desktop\\Atelier';
    expect(isInsidePath(root, root)).toBe(true);
    expect(isInsidePath('c:\\users\\relic\\desktop\\atelier\\', root)).toBe(true);
    expect(isInsidePath('C:/Users/Relic/Desktop/Atelier/spikes/tmp', root)).toBe(true);
    expect(isInsidePath('C:\\Users\\Relic\\Desktop\\Atelier-spikes', root)).toBe(false);
    expect(isInsidePath('C:\\Users\\Relic\\Desktop', root)).toBe(false);
    expect(isInsidePath('/home/me/app/src', '/home/me/app')).toBe(true);
    expect(isInsidePath('/home/me/App/src', '/home/me/app')).toBe(false); // case matters off Windows
    expect(isInsidePath('/home/me/app2', '/home/me/app')).toBe(false);
  });

  it('reads title, prompt, folder and branch from the ends of a transcript', () => {
    const head = jsonl(
      { type: 'last-prompt', sessionId: ID },
      { type: 'user', isMeta: true, cwd: 'C:\\p', message: { content: 'meta text' } },
      { type: 'user', cwd: 'C:\\p', message: { content: '<command-name>/clear</command-name>' } },
      {
        type: 'user',
        cwd: 'C:\\p',
        gitBranch: 'main',
        timestamp: '2026-11-25T21:32:15.928Z',
        message: { content: [{ type: 'text', text: '  fix   the\nlogin form  ' }] },
      },
      { type: 'ai-title', aiTitle: 'Early title' },
    );
    const tail =
      '{"type":"assistant","cut in hal' + '\n' + jsonl({ type: 'ai-title', aiTitle: 'Login form fix' });
    expect(parseSessionHeadTail(head, tail)).toEqual({
      title: 'Login form fix',
      firstPrompt: 'fix the login form',
      cwd: 'C:\\p',
      gitBranch: 'main',
      startedAt: '2026-11-25T21:32:15.928Z',
    });
    // A title the user gave (/rename) wins over a generated one.
    const renamed = parseSessionHeadTail(head, tail + jsonl({ type: 'custom-title', customTitle: 'Mine' }));
    expect(renamed.title).toBe('Mine');
    // No titles: the first prompt.
    expect(parseSessionHeadTail(head.replace(/ai-title/g, 'x'), '').title).toBe('fix the login form');
  });

  it('never throws on garbage, and finds nothing in an empty session', () => {
    expect(parseSessionHeadTail('', '')).toEqual({
      title: null,
      firstPrompt: null,
      cwd: null,
      gitBranch: null,
      startedAt: null,
    });
    const meta = parseSessionHeadTail('{bad json\nnull\n[1,2]\n{"type":"user","message":null}\n', '}{');
    expect(meta.title).toBeNull();
  });

  it('shortens a very long title', () => {
    const long = 'x'.repeat(500);
    const meta = parseSessionHeadTail(jsonl({ type: 'user', cwd: '/p', message: { content: long } }), '');
    expect(Array.from(meta.title!).length).toBe(200);
    expect(meta.title!.endsWith('…')).toBe(true);
  });
});

describe('workspace: Claude session of a terminal', () => {
  const ws = (claude: unknown) =>
    parseWorkspace({
      projects: [
        {
          id: 'p1',
          path: 'C:\\p',
          terminals: [{ id: 't1', name: 'a', profileId: '', lastCwd: null, claude }],
          layout: { columns: [], active: 0 },
        },
      ],
    }).projects[0]!.terminals[0]!;

  it('keeps a valid record', () => {
    expect(ws({ sessionId: ID, codeMode: true, active: true }).claude).toEqual({
      sessionId: ID,
      codeMode: true,
      active: true,
    });
  });

  it('drops a bad id or field, never the terminal', () => {
    expect(ws({ sessionId: 'x; calc', codeMode: 'yes', active: true }).claude).toEqual({
      sessionId: null,
      codeMode: false,
      active: true,
    });
    expect(ws(undefined).claude).toBeUndefined();
    expect(ws('garbage').claude).toBeUndefined();
    expect(ws(42).id).toBe('t1');
  });
});
