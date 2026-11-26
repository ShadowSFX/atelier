import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/** The renderer's inspection hook (src/renderer/terminal/registry.ts), as seen from page.evaluate. */
interface Sent {
  terminalId: string;
  kind: string;
  title: string;
  body: string;
  shown: boolean;
}
declare const window: {
  __atelier?: { ids(): string[]; text(id: string): string | null; notifications(): readonly Sent[] };
};

/**
 * Desktop notifications: the settings section, long commands, the bell, the rate limit and the click. Drives the
 * built app (npm run build) with a throwaway profile; Windows PowerShell is the default shell.
 */
const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-e2e-notify-'));
const userData = join(base, 'profile');
const projA = join(base, 'alpha');
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

async function openProject(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, d) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:open-project', d),
    dir,
  );
}

const ids = (page: Page) => page.evaluate(() => window.__atelier!.ids());
const text = (page: Page, id: string) => page.evaluate((i) => window.__atelier!.text(i) ?? '', id);
const sent = (page: Page) => page.evaluate(() => [...window.__atelier!.notifications()]);

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line, { delay: 2 });
  await page.keyboard.press('Enter');
}

test('desktop notifications', async () => {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, ATELIER_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openProject(app, projB);
  await expect.poll(async () => (await ids(page)).length).toBe(1);
  const [b] = await ids(page);
  await openProject(app, projA);
  await expect.poll(async () => (await ids(page)).length).toBe(2);
  const a = (await ids(page)).find((x) => x !== b)!;
  await expect.poll(() => text(page, a)).toMatch(/alpha/);

  // ── Settings: the master switch gates the others; the minimum duration follows "Long command finished".
  await page.getByRole('button', { name: /^(Configuración|Settings) \(Ctrl\+,\)$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/^(Notificaciones|Notifications)$/)).toBeVisible();
  const master = dialog.getByRole('switch', { name: /Notificaciones de escritorio|Desktop notifications/ });
  const bell = dialog.getByRole('switch', { name: /Campana de la terminal|Terminal bell/ });
  const longCmd = dialog.getByRole('switch', { name: /Comando largo terminado|Long command finished/ });
  const seconds = dialog.getByRole('spinbutton', { name: /Duración mínima|Minimum duration/ });
  const sound = dialog.getByRole('switch', { name: /^(Sonido|Play sound)$/ });
  const permission = dialog.getByRole('switch', { name: /Claude pide permiso|Claude asks for permission/ });
  const question = dialog.getByRole('switch', {
    name: /Claude te hace una pregunta|Claude asks you a question/,
  });
  await expect(master).toHaveAttribute('aria-checked', 'true');
  await expect(seconds).toHaveValue('10');
  for (const sw of [sound, permission, question]) await expect(sw).toHaveAttribute('aria-checked', 'true');
  await master.click();
  await expect(master).toHaveAttribute('aria-checked', 'false');
  await expect(bell).toBeDisabled();
  await expect(seconds).toBeDisabled();
  for (const sw of [sound, permission, question]) await expect(sw).toBeDisabled();
  await master.click();
  await expect(bell).toBeEnabled();
  // Permissions and questions are separate switches.
  await question.click();
  await expect(question).toHaveAttribute('aria-checked', 'false');
  await expect(permission).toHaveAttribute('aria-checked', 'true');
  await question.click();
  await expect(question).toHaveAttribute('aria-checked', 'true');
  await longCmd.click();
  await expect(seconds).toBeDisabled();
  await longCmd.click();
  await expect(seconds).toBeEnabled();
  await seconds.fill('1');
  await expect(seconds).toHaveValue('1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // ── A long command that fails: title with its exit code and duration, body with the command and where it ran.
  await page.locator('main section').first().click();
  await typeLine(page, 'cmd /c "ping -n 3 127.0.0.1 >nul & echo done-ping & exit /b 3"');
  await expect.poll(() => text(page, a), { timeout: 30_000 }).toMatch(/^done-ping\s*$/m);
  await expect
    .poll(async () => (await sent(page)).filter((n) => n.kind === 'command'), { timeout: 10_000 })
    .toHaveLength(1);
  const cmd = (await sent(page)).find((n) => n.kind === 'command')!;
  expect(cmd.terminalId).toBe(a);
  expect(cmd.title).toMatch(/(código|exit code) 3/);
  expect(cmd.title).toMatch(/\d+s/);
  expect(cmd.body).toContain('ping -n 3');
  expect(cmd.body).toMatch(/alpha/);
  expect(cmd.shown).toBe(true);

  // A short command is not news.
  await typeLine(page, '"quick"');
  await expect.poll(() => text(page, a)).toMatch(/^quick$/m);

  // ── The bell, at most once per terminal in the rate-limit window.
  await typeLine(page, 'Write-Host "$([char]7)bell-1"');
  await expect.poll(() => text(page, a)).toMatch(/bell-1/);
  await expect.poll(async () => (await sent(page)).filter((n) => n.kind === 'bell')).toHaveLength(1);
  await typeLine(page, 'Write-Host "$([char]7)bell-2"');
  await expect.poll(() => text(page, a)).toMatch(/bell-2/);
  await page.waitForTimeout(500);
  expect((await sent(page)).filter((n) => n.kind === 'bell')).toHaveLength(1);
  expect((await sent(page)).filter((n) => n.kind === 'command')).toHaveLength(1);

  // ── Clicking a notification shows its terminal, in its project.
  await expect(page.getByRole('tab', { name: 'alpha' })).toHaveAttribute('aria-selected', 'true');
  await app.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0]!.webContents.send('notify:activate', id),
    b!,
  );
  await expect(page.getByRole('tab', { name: 'beta' })).toHaveAttribute('aria-selected', 'true');

  // ── A long command the user stops with Ctrl+C is not news (they are there).
  await page.locator('main section').first().click();
  await typeLine(page, 'Start-Sleep -Seconds 4; "not-reached"');
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Control+C');
  // The interrupted command's prompt (with its failure mark) must be drawn before typing again.
  await expect.poll(() => text(page, b!), { timeout: 10_000 }).toMatch(/✘ 1[^\n]*\$[^\n\w"]*$/);
  await typeLine(page, '"after-interrupt"');
  await expect.poll(() => text(page, b!), { timeout: 30_000 }).toMatch(/^after-interrupt$/m);
  expect(await text(page, b!)).not.toMatch(/^not-reached$/m);
  await page.waitForTimeout(500);
  expect((await sent(page)).filter((n) => n.kind === 'command' && n.terminalId === b)).toHaveLength(0);

  // ── Master off: nothing more is sent.
  await page.getByRole('button', { name: /^(Configuración|Settings) \(Ctrl\+,\)$/ }).click();
  await master.click();
  await page.keyboard.press('Escape');
  await page.locator('main section').first().click();
  await typeLine(page, 'Start-Sleep -Milliseconds 1500; Write-Host "$([char]7)after-off"');
  await expect.poll(() => text(page, b!), { timeout: 30_000 }).toMatch(/after-off/);
  await page.waitForTimeout(500);
  expect(await sent(page)).toHaveLength(2);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
  await app.close().catch(() => undefined);
});
