import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/** The renderer's hooks, as seen from page.evaluate. */
declare const window: {
  __atelier?: { ids(): string[]; text(id: string, lines?: number): string | null };
  atelier: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
};

/**
 * The project library with the built app and a throwaway profile: adding folders (analyzed locally; Claude's
 * descriptions are off in throwaway profiles), opening one as a tab, moving it while a program runs in its terminal,
 * closing and reopening it with its terminals, and a folder that disappears.
 */
const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-e2e-lib-'));
const userData = join(base, 'profile');
const desk = join(base, 'desk');
const webapp = join(desk, 'webapp');
const tool = join(desk, 'tool');
const shortcuts = join(desk, 'shortcuts');
const shelf = join(base, 'Shelf');
for (const d of [webapp, join(webapp, 'src'), tool, shortcuts, shelf]) mkdirSync(d, { recursive: true });
writeFileSync(
  join(webapp, 'package.json'),
  JSON.stringify({ description: 'A test web app', dependencies: { react: '19' } }),
);
writeFileSync(join(webapp, 'src', 'main.tsx'), 'export {};');
writeFileSync(join(tool, 'requirements.txt'), 'fastapi\n');
writeFileSync(join(tool, 'main.py'), 'print(1)\n');
writeFileSync(join(shortcuts, 'server.rdp'), 'full address:s:x');

test.afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* a crashed app may still hold files */
  }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, ATELIER_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');
  return { app, page };
}

const invoke = (page: Page, channel: string, ...args: unknown[]) =>
  page.evaluate(([c, a]) => window.atelier.invoke(c as string, ...(a as unknown[])), [
    channel,
    args,
  ] as const);
const ids = (page: Page) => page.evaluate(() => window.__atelier!.ids());
const text = (page: Page, id: string) => page.evaluate((i) => window.__atelier!.text(i) ?? '', id);
const card = (page: Page, name: string) => page.locator('[data-entry]').filter({ hasText: name }).first();

test('library: add, open, move a live project, remember terminals, missing folder', async () => {
  test.setTimeout(180_000);
  let { app, page } = await launch();

  // A fresh profile starts on the empty library.
  await expect(
    page.getByRole('heading', { name: /Bring your projects together|Reúne tus proyectos/ }),
  ).toBeVisible();

  // Scanning tells code from a folder of shortcuts.
  const scan = (await invoke(page, 'library:scan', desk)) as {
    name: string;
    facts: { isCode: boolean; stack: string[] };
  }[];
  const byName = Object.fromEntries(scan.map((x) => [x.name, x.facts]));
  expect(byName.webapp!.isCode).toBe(true);
  expect(byName.webapp!.stack).toContain('React');
  expect(byName.tool!.stack).toContain('FastAPI');
  expect(byName.shortcuts!.isCode).toBe(false);

  await invoke(page, 'library:add', [webapp, tool]);
  await expect(page.locator('[data-entry]')).toHaveCount(2);
  await expect(card(page, 'webapp')).toContainText('A test web app');
  await expect(card(page, 'webapp')).toContainText('React');

  // Open it: a tab and a shell in its folder.
  await card(page, 'webapp').dblclick();
  await expect(page.getByRole('tab', { name: 'webapp' })).toBeVisible();
  await expect.poll(async () => (await ids(page)).length).toBe(1);
  const [term] = await ids(page);
  await expect.poll(() => text(page, term!), { timeout: 30_000 }).toMatch(/webapp/);

  // Something runs in it.
  await page.locator('main section').first().click();
  await page.keyboard.type('node -e "setInterval(()=>{},1000)"', { delay: 2 });
  await page.keyboard.press('Enter');

  // Move it into a library folder from the library's menu.
  await invoke(page, 'library:update', { op: 'folderAdd', id: 'f1', path: shelf });
  await page.locator('header button[aria-label]').first().click(); // the logo: library
  await card(page, 'webapp').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^(Move…|Mover…)$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(join(shelf, 'webapp'));
  // The running program is listed before anything happens.
  await expect(dialog).toContainText(/node will stop|node se detendrá/, { timeout: 15_000 });
  await dialog.getByRole('button', { name: /Move project|Mover proyecto/ }).click();
  await expect(dialog).toContainText(/Project moved|Proyecto movido/, { timeout: 60_000 });
  await dialog.getByRole('button', { name: /^(Close|Cerrar)$/ }).click();

  expect(existsSync(join(shelf, 'webapp', 'package.json'))).toBe(true);
  expect(existsSync(webapp)).toBe(false);
  // The same terminal started again in the new place.
  await page.getByRole('tab', { name: 'webapp' }).dispatchEvent('pointerdown', { button: 0 });
  expect(await ids(page)).toEqual([term]);
  await expect.poll(() => text(page, term!), { timeout: 30_000 }).toMatch(/Shelf/);

  // Closing keeps the setup; opening brings the same terminal back.
  await page.getByRole('tab', { name: 'webapp' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^(Close project|Cerrar proyecto)$/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Close project|Cerrar proyecto)$/ })
    .click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(card(page, 'webapp')).toBeVisible(); // the last tab closed: back to the library
  await card(page, 'webapp').dblclick();
  await expect.poll(() => ids(page)).toEqual([term]);

  // A folder deleted outside Atelier shows as not found.
  rmSync(tool, { recursive: true, force: true });
  await page.locator('header button[aria-label]').first().click();
  await expect(card(page, 'tool')).toContainText(/Not found|No encontrado/, { timeout: 15_000 });

  // The library survives a restart.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
  await app.close().catch(() => undefined);
  ({ app, page } = await launch());
  await page.locator('header button[aria-label]').first().click();
  await expect(page.locator('[data-entry]')).toHaveCount(2);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
  await app.close().catch(() => undefined);
});
