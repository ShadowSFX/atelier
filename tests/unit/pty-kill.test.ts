import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_KILL_WAIT_MS } from '@shared/constants';

/** A fake node-pty process: kill() is recorded, the test decides when it exits. */
class FakePty {
  static all: FakePty[] = [];
  static log: string[] = [];
  readonly pid = 1000 + FakePty.all.length;
  private exitListeners = new Set<(e: { exitCode: number }) => void>();
  constructor() {
    FakePty.all.push(this);
    FakePty.log.push(`spawn ${this.pid}`);
  }
  onData() {
    return { dispose() {} };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exitListeners.add(l);
    return { dispose: () => this.exitListeners.delete(l) };
  }
  kill() {
    FakePty.log.push(`kill ${this.pid}`);
  }
  exit() {
    for (const l of [...this.exitListeners]) l({ exitCode: 0 });
  }
  write() {}
  resize() {}
  pause() {}
  resume() {}
}

vi.mock('node-pty', () => ({ spawn: () => new FakePty() }));
vi.mock('../../src/main/log', () => ({ log: { warn() {}, error() {}, info() {} } }));
vi.mock('../../src/main/shell/integration', () => ({
  buildLaunch: () => ({ file: 'shell.exe', args: [], cwd: '.', env: {} }),
}));

const { PtyManager } = await import('../../src/main/pty/PtyManager');

const profile = { id: 'p', name: 'Shell', file: 'shell.exe', args: [], kind: 'pwsh' };
const manager = () =>
  new PtyManager({ get: async () => profile, defaultId: async () => 'p' } as never, {} as never, {
    envFor: () => ({}),
    claudeExe: () => null,
    powerline: () => false,
  });
const spawn = (m: InstanceType<typeof PtyManager>, id: string) =>
  m.spawn({ terminalId: id, projectId: 'proj', profileId: 'p', cwd: '.', cols: 80, rows: 24 }, 'p');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PtyManager on Windows: one shell dies at a time (node-pty exit threads race)', () => {
  const platform = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: platform }));
  beforeEach(() => {
    FakePty.all = [];
    FakePty.log = [];
  });

  it('kills the next shell only after the previous one exited', async () => {
    const m = manager();
    for (const id of ['a', 'b', 'c']) await spawn(m, id);
    const [a, b, c] = FakePty.all;
    FakePty.log = [];

    m.killAll();
    expect(m.has('a') || m.has('b') || m.has('c')).toBe(false); // gone for callers right away
    let settled = false;
    void m.settled().then(() => (settled = true));
    await tick();
    expect(FakePty.log).toEqual([`kill ${a!.pid}`]);
    a!.exit();
    await tick();
    expect(FakePty.log).toEqual([`kill ${a!.pid}`, `kill ${b!.pid}`]);
    b!.exit();
    await tick();
    expect(settled).toBe(false);
    c!.exit();
    await tick();
    expect(FakePty.log).toEqual([`kill ${a!.pid}`, `kill ${b!.pid}`, `kill ${c!.pid}`]);
    expect(settled).toBe(true);
  });

  it('moves on after PTY_KILL_WAIT_MS when a shell never reports its exit', async () => {
    vi.useFakeTimers();
    try {
      const m = manager();
      await spawn(m, 'a');
      await spawn(m, 'b');
      const [a, b] = FakePty.all;
      FakePty.log = [];
      m.killAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakePty.log).toEqual([`kill ${a!.pid}`]);
      await vi.advanceTimersByTimeAsync(PTY_KILL_WAIT_MS);
      expect(FakePty.log).toEqual([`kill ${a!.pid}`, `kill ${b!.pid}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart spawns the new shell only after the old one exited', async () => {
    const m = manager();
    await spawn(m, 'a');
    const [old] = FakePty.all;
    FakePty.log = [];
    const restarted = spawn(m, 'a');
    await tick();
    await tick();
    expect(FakePty.log).toEqual([`kill ${old!.pid}`]);
    old!.exit();
    const r = await restarted;
    expect(r.ok).toBe(true);
    expect(FakePty.log).toEqual([`kill ${old!.pid}`, `spawn ${FakePty.all[1]!.pid}`]);
  });

  it('a queued shell that exits by itself meanwhile is not killed', async () => {
    const m = manager();
    await spawn(m, 'a');
    await spawn(m, 'b');
    const [a, b] = FakePty.all;
    FakePty.log = [];
    m.killAll();
    await tick();
    b!.exit(); // b dies on its own while a is still being killed
    a!.exit();
    await m.settled();
    expect(FakePty.log).toEqual([`kill ${a!.pid}`]);
  });
});
