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
    'echo FAKE-CLAUDE args=[%*] codemode=[%CLAUDE_CODE_EXPERIMENTAL_CODE_MODE%]',
    'echo %* | findstr /c:"--resume" >nul && exit /b 0',
    'ping -n 300 127.0.0.1 >nul',
  ].join('\r\n'),
);
// One earlier session of the project, for the picker (Claude's folder naming: non-alphanumerics → "-").
const sessionDir = join(claudeConfig, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(sessionDir, { recursive: true });
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

  // Power cut: the process tree dies without closing anything.
  await crash(app);

  // Restart: the terminal resumes its session (Code Mode still on); the plain shell stays a shell.
  ({ app, page } = await launch());
  await expect.poll(async () => (await ids(page)).sort()).toEqual([claude, shell].sort());
  await waitText(
    page,
    claude,
    new RegExp(`FAKE-CLAUDE args=\\[[^\\]]*--resume ${SESSION}\\] codemode=\\[1\\]`),
  );
  expect(await text(page, shell!)).not.toMatch(/FAKE-CLAUDE args=\[[^\]]*--resume/);
  // The fake ends a resumed session at once: the shell prompt comes back and the session is no longer resumed.
  await expect.poll(() => savedTerminal(claude).claude?.active).toBe(false);
  expect(savedTerminal(claude).claude?.sessionId).toBe(SESSION);

  // The picker lists the project's earlier session; choosing it resumes it in a new terminal.
  await page.getByRole('button', { name: /Nueva terminal con|New terminal with/ }).click();
  await page.getByRole('menuitem', { name: /Reanudar|Resume/ }).click();
  const row = page.locator(`[data-session="${OLD_SESSION}"]`);
  await expect(row).toContainText('Parser refactor');
  await expect(row).toContainText('feature/x');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await ids(page)).length).toBe(3);
  const resumed = (await ids(page)).find((x) => x !== claude && x !== shell)!;
  await waitText(
    page,
    resumed,
    new RegExp(`FAKE-CLAUDE args=\\[[^\\]]*--resume ${OLD_SESSION}\\] codemode=\\[\\]`),
  );

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

  await crash(app);
});
