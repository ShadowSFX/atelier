import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
/** The renderer's inspection hook (src/renderer/terminal/registry.ts), as seen from page.evaluate. */
declare const window: { __atelier?: { ids(): string[] } };
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { ClaudeStatus } from '../../src/shared/ipc';

/**
 * The sidebar row of a terminal: Claude's status on the second line (no process name or path any more), and the
 * title Claude gives the terminal (atelier_set_title), which a name given by hand overrides. Main's events are
 * sent directly, so no real Claude session is needed.
 */
const root = resolve(__dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'atelier-status-'));
const project = join(base, 'status-proj');
mkdirSync(project);
test.afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* a crashed app may still hold files */
  }
});

function emit(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, { channel, args }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, ...args),
    { channel, args },
  );
}

test('Claude status and title on the sidebar row', async () => {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, ATELIER_USER_DATA: join(base, 'profile') },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');
  await emit(app, 'app:open-project', project);
  await expect.poll(() => page.evaluate(() => window.__atelier!.ids().length)).toBeGreaterThan(0);
  const id = (await page.evaluate(() => window.__atelier!.ids()))[0]!;
  const row = page.getByRole('option').first();
  const status = row.locator(`[data-claude-terminal="${id}"]`);

  // No Claude session: no status, and neither the path nor the running process is shown.
  await expect(status).toHaveCount(0);
  await expect(row).not.toContainText('status-proj');

  const states: [ClaudeStatus['state'], RegExp][] = [
    ['busy', /Procesando|Processing/],
    ['waiting', /Esperando respuesta|Waiting for answers/],
    ['done', /Terminado|Finished/],
    ['idle', /Inactivo|Idle/],
  ];
  for (const [state, label] of states) {
    await emit(app, 'claude:status', { terminalId: id, state, queued: 0 } satisfies ClaudeStatus);
    await expect(status).toHaveAttribute('data-claude-state', state!);
    await expect(status).toHaveText(label);
  }
  await emit(app, 'claude:status', { terminalId: id, state: 'idle', queued: 2 } satisfies ClaudeStatus);
  await expect(status).toContainText('2');
  await emit(app, 'claude:status', { terminalId: id, state: null, queued: 0 } satisfies ClaudeStatus);
  await expect(status).toHaveCount(0);

  // Claude names the terminal…
  await emit(app, 'terminal:set-title', id, 'Login form validation');
  await expect(row).toContainText('Login form validation');

  // …until the user names it by hand.
  await row.dblclick();
  const input = page.getByRole('dialog').getByRole('textbox');
  await input.fill('My API');
  await input.press('Enter');
  await expect(row).toContainText('My API');
  await emit(app, 'terminal:set-title', id, 'Something else');
  await page.waitForTimeout(300);
  await expect(row).toContainText('My API');

  // "Let Claude rename" unlocks it.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Dejar que Claude|Let Claude rename/ }).click();
  await emit(app, 'terminal:set-title', id, 'Something else');
  await expect(row).toContainText('Something else');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
});
