import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
/** The renderer's inspection hook (src/renderer/terminal/registry.ts), as seen from page.evaluate. */
declare const window: { __atelier?: { ids(): string[]; text(id: string, lines?: number): string | null } };
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * The + launcher menu, Claude session restore after a crash, and the session picker. A fake `claude` (a .cmd on
 * PATH) prints its arguments and the Code Mode variable; with --resume it exits at once (its session "ends"),
 * otherwise it keeps running like an idle Claude. Hooks are simulated by sending main's `claude:session` event.
 */
const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-launch-'));
const userData = join(base, 'profile');
const project = join(base, 'launch-proj');
const fakeBin = join(base, 'bin');
const claudeConfig = join(base, 'claude-config');
mkdirSync(project);
mkdirSync(fakeBin);
const SESSION = '4574a299-53dc-4ef0-a013-778da5087089';
const OLD_SESSION = '9d0c1d2e-1111-4222-8333-444455556666';

writeFileSync(
  join(fakeBin, 'claude.cmd'),
  [
    '@echo off',
    'if "%1"=="agents" goto agents',
    'if "%1"=="stop" goto stop',
    'echo FAKE-CLAUDE args=[%*] codemode=[%CLAUDE_CODE_EXPERIMENTAL_CODE_MODE%]',
    '>>"%~dp0runs.txt" echo %*',
    'echo %* | findstr /c:"--resume" /c:" attach " >nul && exit /b 0',
    'ping -n 300 127.0.0.1 >nul',
    'exit /b 0',
    // `claude agents --json` (main asks before resuming) and `claude stop <id>` (logged).
    ':agents',
    'type "%~dp0agents.json"',
    'exit /b 0',
    ':stop',
    '>>"%~dp0stopped.txt" echo %2',
    'exit /b 0',
  ].join('\r\n'),
);
// Both sessions are still running in Claude Code's background: SESSION idle (stopped, then resumed), OLD_SESSION busy
// (attached to).
writeFileSync(
  join(fakeBin, 'agents.json'),
  JSON.stringify([
    { pid: 101, id: 'a0a0a0a0', kind: 'background', sessionId: SESSION, status: 'idle' },
    { pid: 102, id: 'b0b0b0b0', kind: 'background', sessionId: OLD_SESSION, status: 'busy' },
  ]),
);
const stoppedIds = () => {
  try {
    return readFileSync(join(fakeBin, 'stopped.txt'), 'utf8').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
};
/** The arguments of every interactive `claude` the fake ran, in order (a restored terminal's old text can't fool it). */
const runs = () => {
  try {
    return readFileSync(join(fakeBin, 'runs.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
};
// One earlier session of the project, for the picker (Claude's folder naming: non-alphanumerics → "-").
const sessionDir = join(claudeConfig, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(sessionDir, { recursive: true });
// SESSION was used: it has a message to resume (untitled, so the picker below doesn't list it). EMPTY_SESSION was
// opened and never typed into: Claude Code wrote no transcript, and `--resume` would refuse it.
const EMPTY_SESSION = '7a1b2c3d-3333-4444-8555-666677778888';
writeFileSync(
  join(sessionDir, `${SESSION}.jsonl`),
  JSON.stringify({ type: 'assistant', message: { content: 'done' } }) + '\n',
);
writeFileSync(
  join(sessionDir, `${OLD_SESSION}.jsonl`),
  [
    { type: 'user', cwd: project, gitBranch: 'feature/x', message: { content: 'refactor the parser' } },
    { type: 'ai-title', aiTitle: 'Parser refactor' },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n',
);

test.skip(process.platform !== 'win32', 'the fake claude is a .cmd');
test.afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* a killed app may still hold files */
  }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...process.env,
      ATELIER_USER_DATA: userData,
      CLAUDE_CONFIG_DIR: claudeConfig,
      PATH: fakeBin + delimiter + (process.env.PATH ?? ''),
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');
  return { app, page };
}

/** Kills Atelier and everything it started (shells, the fake claude), like a power cut. */
async function crash(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  if (pid) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
}

const ids = (page: Page) => page.evaluate(() => window.__atelier!.ids());
const text = (page: Page, id: string) => page.evaluate((i) => window.__atelier!.text(i) ?? '', id);
async function waitText(page: Page, id: string, re: RegExp, timeout = 30_000): Promise<void> {
  await expect.poll(() => text(page, id), { timeout, message: `terminal text matching ${re}` }).toMatch(re);
}
interface SavedTerminal {
  id?: string;
  claude?: { sessionId: string | null; codeMode: boolean; active: boolean };
}
function savedTerminal(id: string): SavedTerminal {
  try {
    const ws = JSON.parse(readFileSync(join(userData, 'workspace.json'), 'utf8')) as {
      projects: { terminals: SavedTerminal[] }[];
    };
    return ws.projects.flatMap((p) => p.terminals).find((t) => t.id === id) ?? {};
  } catch {
    return {};
  }
}

test('launcher menu, Claude restore after a crash, session picker', async () => {
  let { app, page } = await launch();
  await app.evaluate(
    ({ BrowserWindow }, d) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:open-project', d),
    project,
  );
  await expect.poll(async () => (await ids(page)).length).toBe(1);
  const [shell] = await ids(page);

  // + opens the launcher menu: what to start, an earlier session, then the shells.
  await page.getByRole('button', { name: /Nueva terminal con|New terminal with/ }).click();
  const items = page.getByRole('menuitem');
  await expect(items.nth(0)).toHaveText(/Terminal/);
  await expect(items.nth(1)).toHaveText(/^Claude Code/);
  await expect(items.nth(2)).toHaveText(/Code Mode/);
  await expect(items.nth(3)).toHaveText(/Reanudar|Resume/);
  await items.nth(2).click();

  // A Code Mode Claude terminal: the shell starts, then `claude` runs in it with the variable set.
  await expect.poll(async () => (await ids(page)).length).toBe(2);
  const claude = (await ids(page)).find((x) => x !== shell)!;
  await waitText(page, claude, /FAKE-CLAUDE args=\[[^\]]*\] codemode=\[1\]/);
  expect(await text(page, shell!)).not.toMatch(/FAKE-CLAUDE/);

  // Its hook reports the session id (simulated); the workspace keeps it.
  await app.evaluate(
    ({ BrowserWindow }, { id, sessionId }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('claude:session', id, { sessionId, codeMode: true }),
    { id: claude, sessionId: SESSION },
  );
  await expect
    .poll(() => savedTerminal(claude).claude)
    .toEqual({ sessionId: SESSION, codeMode: true, active: true });

  // A plain Claude terminal nobody types into: its session id is recorded all the same.
  await page.getByRole('button', { name: /Nueva terminal con|New terminal with/ }).click();
  await page.getByRole('menuitem').nth(1).click();
  await expect.poll(async () => (await ids(page)).length).toBe(3);
  const empty = (await ids(page)).find((x) => x !== shell && x !== claude)!;
  await waitText(page, empty, /FAKE-CLAUDE args=\[[^\]]*\] codemode=\[\]/);
  await app.evaluate(
    ({ BrowserWindow }, { id, sessionId }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('claude:session', id, {
        sessionId,
        codeMode: false,
      }),
    { id: empty, sessionId: EMPTY_SESSION },
  );
  await expect
    .poll(() => savedTerminal(empty).claude)
    .toEqual({ sessionId: EMPTY_SESSION, codeMode: false, active: true });
  const runsBefore = runs().length;

  // Power cut: the process tree dies without closing anything.
  await crash(app);

  // Restart: the terminal resumes its session (Code Mode still on); the plain shell stays a shell. The session is
  // still running idle in Claude Code's background: it is stopped first, so the resume isn't refused.
  ({ app, page } = await launch());
  await expect.poll(async () => (await ids(page)).sort()).toEqual([claude, shell, empty].sort());
  await waitText(
    page,
    claude,
    new RegExp(`FAKE-CLAUDE args=\\[[^\\]]*--resume ${SESSION}\\] codemode=\\[1\\]`),
  );
  expect(await text(page, shell!)).not.toMatch(/FAKE-CLAUDE args=\[[^\]]*--resume/);
  expect(stoppedIds()).toEqual(['a0a0a0a0']);
  // The fake ends a resumed session at once: the shell prompt comes back and the session is no longer resumed.
  await expect.poll(() => savedTerminal(claude).claude?.active).toBe(false);
  expect(savedTerminal(claude).claude?.sessionId).toBe(SESSION);
  // The empty session has nothing to resume: its terminal starts a new Claude session instead of a refused --resume.
  await expect.poll(() => runs().slice(runsBefore).length, { timeout: 30_000 }).toBe(2);
  const restarted = runs().slice(runsBefore);
  expect(restarted.filter((a) => a.includes(`--resume ${SESSION}`))).toHaveLength(1);
  expect(restarted.join('\n')).not.toContain(EMPTY_SESSION);
  expect(restarted.filter((a) => !a.includes('--resume'))).toHaveLength(1);

  // The picker lists the project's earlier session; choosing it opens it in a new terminal. It is busy in Claude
  // Code's background, so the terminal attaches to it instead of stopping it.
  await page.getByRole('button', { name: /Nueva terminal con|New terminal with/ }).click();
  await page.getByRole('menuitem', { name: /Reanudar|Resume/ }).click();
  const row = page.locator(`[data-session="${OLD_SESSION}"]`);
  await expect(row).toContainText('Parser refactor');
  await expect(row).toContainText('feature/x');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await ids(page)).length).toBe(4);
  const resumed = (await ids(page)).find((x) => x !== claude && x !== shell && x !== empty)!;
  await waitText(page, resumed, /FAKE-CLAUDE args=\[[^\]]*attach b0b0b0b0\] codemode=\[\]/);
  expect(stoppedIds()).toEqual(['a0a0a0a0']);

  // The real hook script, fed Claude's SessionStart input from inside a terminal (its env carries the hub token):
  // the session id and Code Mode (from the hook's environment) reach the workspace through the hub.
  const NEW_SESSION = '0b7e2c1d-2222-4333-8444-555566667777';
  const electronExe = await app.evaluate(() => process.execPath);
  const hookScript = join(root, 'out', 'main', 'agent-hook.js');
  await page
    .getByRole('option', { name: /Windows PowerShell|PowerShell/ })
    .first()
    .click();
  await page.locator('main section').first().click();
  await page.keyboard.type(
    `$env:ELECTRON_RUN_AS_NODE='1'; $env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE='1'; ` +
      `'{"hook_event_name":"SessionStart","session_id":"${NEW_SESSION}","source":"startup"}' | ` +
      `& '${electronExe}' '${hookScript}'`,
    { delay: 1 },
  );
  await page.keyboard.press('Enter');
  await expect
    .poll(() => savedTerminal(shell!).claude, { timeout: 15_000 })
    .toEqual({ sessionId: NEW_SESSION, codeMode: true, active: true });

  // The real statusLine script, fed Claude's rate_limits: the weekly usage shows centered in the status bar.
  const statusScript = join(root, 'out', 'main', 'agent-status.js');
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86400;
  await page.keyboard.type(
    `'{"cwd":"C:\\\\nowhere","rate_limits":{"seven_day":{"used_percentage":41.2,"resets_at":${resetsAt}},` +
      `"five_hour":{"used_percentage":12,"resets_at":${resetsAt - 2 * 86400}}}}' | ` +
      `& '${electronExe}' '${statusScript}'`,
    { delay: 1 },
  );
  await page.keyboard.press('Enter');
  const meter = page.locator('footer [role="meter"]');
  await expect(meter).toHaveAttribute('aria-valuenow', '41', { timeout: 15_000 });
  await expect(meter).toContainText('41%');
  await expect(meter).toHaveAttribute('title', /12%/);

  await crash(app);
});
