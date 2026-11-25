import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
/** The renderer's inspection hook (src/renderer/terminal/registry.ts), as seen from page.evaluate. */
declare const window: { __atelier?: { ids(): string[]; text(id: string, lines?: number): string | null } };
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Drives the built app (npm run build) with a throwaway profile. Windows PowerShell is the default shell here;
 * the test types PowerShell commands.
 */
const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-e2e-'));
const userData = join(base, 'profile');
const projA = join(base, 'alpha project');
const projB = join(base, 'beta');
mkdirSync(projA);
mkdirSync(projB);

test.afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* a crashed app may still hold files */
  }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ATELIER_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.waitForSelector('header');
  return { app, page };
}

async function openProject(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, d) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:open-project', d), dir);
}

const terminalIds = (page: Page) => page.evaluate(() => window.__atelier!.ids());
const text = (page: Page, id: string) => page.evaluate((i) => window.__atelier!.text(i) ?? '', id);

/** Waits until a terminal's buffer matches. */
async function waitText(page: Page, id: string, re: RegExp, timeout = 30_000): Promise<string> {
  let last = '';
  await expect
    .poll(async () => (last = await text(page, id)), { timeout, message: `terminal text matching ${re}` })
    .toMatch(re);
  return last;
}

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line, { delay: 2 });
  await page.keyboard.press('Enter');
}

/** Red pixels (ANSI red background: #F0605D in Atelier Night, #C8323A in Atelier Day) in the first pane's body, as composited. */
async function redPixels(app: ElectronApplication, page: Page): Promise<number> {
  const box = await page.locator('main section').first().boundingBox();
  if (!box) throw new Error('no pane');
  const rect = { x: Math.round(box.x), y: Math.round(box.y + 40), width: Math.round(box.width), height: Math.round(box.height - 40) };
  return app.evaluate(async ({ BrowserWindow }, r) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(r);
    const bmp = img.toBitmap(); // BGRA
    let n = 0;
    for (let i = 0; i < bmp.length; i += 4) if (bmp[i + 2]! > 180 && bmp[i + 1]! < 120 && bmp[i]! < 120) n++;
    return n;
  }, rect);
}

async function switchTo(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).dispatchEvent('pointerdown', { button: 0 });
}

test('projects, terminals, panes, no stale paint, restore', async () => {
  let { app, page } = await launch();

  await openProject(app, projA);
  await openProject(app, projB);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await switchTo(page, 'alpha project');

  // A terminal starts in the project's folder, with Atelier's prompt.
  await expect.poll(async () => (await terminalIds(page)).length).toBeGreaterThanOrEqual(1);
  const [a] = await terminalIds(page);
  await waitText(page, a!, /alpha project/);
  await page.locator('main section').first().click();
  await typeLine(page, '(Get-Location).Path');
  await waitText(page, a!, new RegExp(projA.replace(/[\\]/g, '\\\\').replace(/ /g, ' ')));

  // Paint red blocks, switch projects: the blocks must be repainted when the terminal comes back.
  await typeLine(page, '$e=[char]27; 1..12 | % { "$e[41m" + (" " * 50) + "$e[0m" }');
  await expect.poll(() => redPixels(app, page)).toBeGreaterThan(2000);
  for (let i = 0; i < 5; i++) {
    await switchTo(page, 'beta');
    await switchTo(page, 'alpha project');
  }
  await expect.poll(() => redPixels(app, page)).toBeGreaterThan(2000);

  // Clear, switch around: nothing red may stay painted (the stale-text glitch).
  await typeLine(page, 'Clear-Host');
  await expect.poll(() => redPixels(app, page)).toBeLessThan(50);
  for (let i = 0; i < 5; i++) {
    await switchTo(page, 'beta');
    await switchTo(page, 'alpha project');
  }
  await expect.poll(() => redPixels(app, page)).toBeLessThan(50);

  // A flood while switching: the UI stays responsive and nothing is lost.
  await typeLine(page, '1..20000 | % { "line $_" }');
  for (let i = 0; i < 20; i++) {
    await switchTo(page, i % 2 ? 'alpha project' : 'beta');
  }
  await switchTo(page, 'alpha project');
  await waitText(page, a!, /line 20000/, 60_000);

  // Split: a second column with a new terminal.
  // Ctrl+V with files copied in Explorer pastes their paths, quoted for PowerShell.
  if (process.platform === 'win32') {
    const f1 = join(projA, "it's a file.txt");
    const f2 = join(projA, 'plain.txt');
    writeFileSync(f1, 'x');
    writeFileSync(f2, 'x');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath '${f1.replace(/'/g, "''")}','${f2}'`]);
    await page.locator('main section').first().click();
    await page.keyboard.press('Control+v');
    await waitText(page, a!, /'[^\n]*it''s a file\.txt' [^\n]*plain\.txt/);
    await page.keyboard.press('Escape'); // PSReadLine: clear the line
  }

  await page.locator('main section').first().click();
  await page.keyboard.press('Control+Shift+Digit5');
  await expect(page.locator('main section')).toHaveCount(2);
  const ids = await terminalIds(page);
  expect(ids.length).toBeGreaterThanOrEqual(2);

  // Close and reopen: projects, terminals and the screen come back.
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByRole('tab')).toHaveCount(2);
  await switchTo(page, 'alpha project');
  await expect(page.locator('main section')).toHaveCount(2);
  await waitText(page, a!, /line 20000/);
  await waitText(page, a!, /sesión restaurada|session restored/);
  await app.close();
});
