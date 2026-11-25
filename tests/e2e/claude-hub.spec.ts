import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
/** The renderer's inspection hook (src/renderer/terminal/registry.ts), as seen from page.evaluate. */
declare const window: { __atelier?: { ids(): string[]; text(id: string, lines?: number): string | null } };
import { _electron as electron, expect, test, type Page } from '@playwright/test';

/**
 * Real Claude Code sessions inside Atelier talking through the hub. Uses the installed `claude` and the API, so it
 * only runs with ATELIER_E2E_CLAUDE=1.
 */
test.skip(!process.env.ATELIER_E2E_CLAUDE, 'set ATELIER_E2E_CLAUDE=1 to run against real Claude Code sessions');

const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-hub-'));
const projA = join(base, 'hub-a');
const projB = join(base, 'hub-b');
mkdirSync(projA);
mkdirSync(projB);
test.afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* files still held */
  }
});

const ids = (page: Page) => page.evaluate(() => window.__atelier!.ids());
const text = (page: Page, id: string) => page.evaluate((i) => window.__atelier!.text(i) ?? '', id);
async function waitText(page: Page, id: string, re: RegExp, timeout = 90_000): Promise<void> {
  await expect.poll(() => text(page, id), { timeout, intervals: [500] }).toMatch(re);
}

/** Starts claude in the focused terminal and accepts the folder trust prompt if it shows up. */
async function startClaude(page: Page, id: string): Promise<void> {
  await page.keyboard.type('claude', { delay: 5 });
  await page.keyboard.press('Enter');
  let trusted = false;
  await expect
    .poll(async () => {
      if (!trusted && /Yes, I trust this folder/.test(await text(page, id))) {
        trusted = true;
        await page.keyboard.press('ArrowDown'); // the default choice is "No, exit"
        await page.keyboard.press('Enter');
      }
      return page.locator(`[data-claude-terminal="${id}"]`).count();
    }, { timeout: 90_000, intervals: [1000] })
    .toBeGreaterThan(0);
}

test('two Claude sessions of one project message each other; another project is out of reach', async () => {
  test.setTimeout(420_000);
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ATELIER_USER_DATA: join(base, 'profile') } });
  const page = await app.firstWindow();
  await page.waitForSelector('header');
  const open = (d: string) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:open-project', p), d);

  await open(projB);
  await expect.poll(async () => (await ids(page)).length).toBe(1);
  const [b1] = await ids(page);
  await open(projA);
  await expect.poll(async () => (await ids(page)).length).toBe(2);
  const a1 = (await ids(page)).find((x: string) => x !== b1)!;
  await page.keyboard.press('Control+Shift+Digit5'); // second terminal of project A, in a new column
  await expect.poll(async () => (await ids(page)).length).toBe(3);
  const a2 = (await ids(page)).find((x: string) => x !== b1 && x !== a1)!;

  // Claude in a2 (focused), then in a1.
  await waitText(page, a2, /hub-a/);
  await startClaude(page, a2);
  await page.locator('main section').first().click();
  await waitText(page, a1, /hub-a/);
  await startClaude(page, a1);

  await page.keyboard.type(
    'Use the atelier_peers tool. Then use atelier_send to send exactly the text PING-42 to the peer that is not self. ' +
      'Then answer: is a tool named ListAgents available to you? End with the line RESULT: yes or RESULT: no',
    { delay: 1 },
  );
  await page.keyboard.press('Enter');

  // The message arrives in a2's prompt and that session answers it.
  try {
    await waitText(page, a2, /Atelier message from[\s\S]*PING-42/, 180_000);
    await waitText(page, a1, /^\s*RESULT: no\s*$/m, 180_000);
  } catch (err) {
    console.error('A1>>', (await text(page, a1)).slice(-4000));
    console.error('A2>>', (await text(page, a2)).slice(-2500));
    throw err;
  }
  // Project B never sees anything of project A.
  expect(await text(page, b1!)).not.toMatch(/PING-42/);

  // Claude is still running in both terminals: Atelier would ask before closing them. Close the window directly.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
  await app.close().catch(() => undefined);
});
