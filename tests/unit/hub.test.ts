import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PeerInfo, SendReport } from '@shared/hub';

vi.mock('../../src/main/log', () => ({
  log: { warn: () => undefined, error: () => undefined, info: () => undefined },
}));

const { Delivery } = await import('../../src/main/hub/Delivery');
const { HubServer } = await import('../../src/main/hub/HubServer');
const { HubClient, sendOnce } = await import('../../src/agent/hubClient');

const peers: Record<string, string[]> = { A: ['a1', 'a2'], B: ['b1'] };
const written: { id: string; data: string }[] = [];
const delivery = new Delivery({
  peersOf: (p) => (peers[p] ?? []).map((id) => ({ id, name: id.toUpperCase(), color: null, cwd: null })),
  write: (id, data) => (written.push({ id, data }), true),
  onStatus: () => undefined,
  now: () => Date.now(),
});
const hub = new HubServer({ delivery, readOutput: async (id, lines) => `${id}:${lines}` });
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await hub.start();
  for (const [project, ids] of Object.entries(peers))
    for (const id of ids) tokens[id] = hub.issueToken(id, project);
});
afterAll(() => hub.stop());

const client = (id: string) => new HubClient({ path: hub.path, token: tokens[id]! }, 'mcp');

describe('HubServer (real pipe)', () => {
  it('scopes peers to the token’s project', async () => {
    const a = await client('a1').request<PeerInfo[]>('peers');
    expect(a.map((p) => p.id)).toEqual(['a1', 'a2']);
    const b = await client('b1').request<PeerInfo[]>('peers');
    expect(b.map((p) => p.id)).toEqual(['b1']);
  });

  it('cannot message or read a terminal of another project', async () => {
    await sendOnce(
      { path: hub.path, token: tokens.b1! },
      { t: 'hook', event: 'SessionStart', at: Date.now() },
    );
    await new Promise((r) => setTimeout(r, 50));
    const r = await client('a1').request<SendReport[]>('send', { to: 'b1', message: 'hi' });
    expect(r[0]!.status).toBe('rejected');
    await expect(client('a1').request('read_output', { terminal: 'b1', lines: 10 })).rejects.toThrow(
      /project/,
    );
    expect(await client('a1').request('read_output', { terminal: 'a2', lines: 10 })).toBe('a2:10');
  });

  it('applies hooks and delivers between sessions of one project', async () => {
    await sendOnce(
      { path: hub.path, token: tokens.a2! },
      { t: 'hook', event: 'SessionStart', at: Date.now() },
    );
    await new Promise((r) => setTimeout(r, 50));
    const r = await client('a1').request<SendReport[]>('send', { to: 'a2', message: 'run the tests' });
    expect(r[0]!.status).toBe('delivered');
    expect(written.some((w) => w.id === 'a2' && w.data.includes('run the tests'))).toBe(true);
  });

  it('refuses unknown and revoked tokens', async () => {
    await expect(
      new HubClient({ path: hub.path, token: 'nope' }, 'mcp').request('peers', {}, 2000),
    ).rejects.toThrow();
    const c = client('a1');
    await c.request('peers');
    hub.revoke('a1');
    await expect(c.request('peers', {}, 2000)).rejects.toThrow();
  });
});
