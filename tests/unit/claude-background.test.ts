import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/log', () => ({ log: { warn() {}, error() {}, info() {} } }));
const { claudeRunner, createResumePreparer } = await import('../../src/main/claude/background');

const base = mkdtempSync(join(tmpdir(), 'atelier-bg-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'win32')('claudeRunner (an npm-style claude.cmd)', () => {
  const cmd = join(base, 'claude.cmd');
  writeFileSync(
    cmd,
    ['@echo off', 'if "%1"=="hang" ping -n 60 127.0.0.1 >nul', 'echo out=[%*]'].join('\r\n'),
  );

  it('returns what it prints', async () => {
    expect((await claudeRunner(cmd, process.env)(['agents', '--json'], 10_000)).trim()).toBe(
      'out=[agents --json]',
    );
  });

  it("gives up at the timeout even while the script's child holds the output, and kills that child", async () => {
    const started = Date.now();
    await expect(claudeRunner(cmd, process.env)(['hang'], 500)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pings = () =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object CommandLine -match ' -n 60 ').Count`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
    await expect.poll(pings, { timeout: 10_000 }).toBe('0');
  }, 20_000);
});

const IDLE = '4574a299-53dc-4ef0-a013-778da5087089';
const BUSY = '57067a84-55c6-47d7-b626-711d2152d80e';
const NONE = 'e322dbb6-e705-439b-82c2-9655b1d41734';
const LISTING = JSON.stringify([
  { pid: 10, id: 'a86a9a2f', kind: 'background', sessionId: IDLE, status: 'idle' },
  { pid: 11, id: '57067a84', kind: 'background', sessionId: BUSY, status: 'busy' },
]);

function fakeRunner(opts: { list?: () => Promise<string>; stop?: () => Promise<string> } = {}) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'agents') return opts.list ? opts.list() : LISTING;
    if (args[0] === 'stop') return opts.stop ? opts.stop() : '';
    throw new Error('unexpected');
  });
  return { run, calls };
}

describe('createResumePreparer', () => {
  it('resumes as usual when the session is not running in the background', async () => {
    const { run, calls } = fakeRunner();
    expect(await createResumePreparer(run)(NONE)).toEqual({ attach: null });
    expect(calls).toEqual([['agents', '--json']]);
  });

  it('stops an idle background session, then resumes it as usual', async () => {
    const { run, calls } = fakeRunner();
    expect(await createResumePreparer(run)(IDLE)).toEqual({ attach: null });
    expect(calls).toEqual([
      ['agents', '--json'],
      ['stop', 'a86a9a2f'],
    ]);
  });

  it('attaches when stopping fails', async () => {
    const { run } = fakeRunner({ stop: () => Promise.reject(new Error('exit 1')) });
    expect(await createResumePreparer(run)(IDLE)).toEqual({ attach: 'a86a9a2f' });
  });

  it('attaches to a busy one without stopping it', async () => {
    const { run, calls } = fakeRunner();
    expect(await createResumePreparer(run)(BUSY)).toEqual({ attach: '57067a84' });
    expect(calls).toEqual([['agents', '--json']]);
  });

  it('resumes as usual when Claude Code cannot list its sessions, and asks again next time', async () => {
    let fail = true;
    const { run, calls } = fakeRunner({
      list: () => (fail ? Promise.reject(new Error('timeout')) : Promise.resolve(LISTING)),
    });
    const prepare = createResumePreparer(run, () => 0);
    expect(await prepare(BUSY)).toEqual({ attach: null });
    fail = false;
    expect(await prepare(BUSY)).toEqual({ attach: '57067a84' });
    expect(calls.filter((c) => c[0] === 'agents')).toHaveLength(2);
  });

  it('terminals restoring together share one listing, a later restore lists again', async () => {
    let now = 0;
    const { run, calls } = fakeRunner();
    const prepare = createResumePreparer(run, () => now);
    await Promise.all([prepare(NONE), prepare(BUSY), prepare(NONE)]);
    expect(calls.filter((c) => c[0] === 'agents')).toHaveLength(1);
    now = 60_000;
    await prepare(NONE);
    expect(calls.filter((c) => c[0] === 'agents')).toHaveLength(2);
  });
});
