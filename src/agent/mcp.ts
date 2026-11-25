/**
 * MCP server "atelier" for Claude Code sessions started in an Atelier terminal (stdio; run with
 * ELECTRON_RUN_AS_NODE=1). Its tools only reach terminals of the same project: the hub derives the project from
 * this terminal's token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HUB_MAX_MESSAGE, HUB_MAX_READ_LINES } from '@shared/constants';
import type { InboxMessage, PeerInfo, SendReport } from '@shared/hub';
import { HubClient, hubEnv } from './hubClient';

const env = hubEnv();
const hub = env ? new HubClient(env, 'mcp') : null;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function call<T>(op: string, args: Record<string, unknown>, render: (r: T) => string) {
  if (!hub) return fail('This Claude session was not started from an Atelier terminal, so it has no project peers.');
  try {
    return text(render(await hub.request<T>(op, args)));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const server = new McpServer(
  { name: 'atelier', version: '1.0.0' },
  {
    instructions:
      'Atelier groups terminals by project. These tools reach only the other terminals of your project: ' +
      'list them with atelier_peers, message another Claude session with atelier_send (it arrives as a prompt ' +
      'in that session), read messages with atelier_inbox, and read what another terminal shows (a dev server, ' +
      'a test run) with atelier_read_output.',
  },
);

server.registerTool(
  'atelier_peers',
  {
    title: 'List project terminals',
    description:
      'Lists the terminals of this Atelier project (id, name, working directory) and whether a Claude session runs ' +
      'in each (idle, busy, or waiting for permission). Your own terminal is marked self.',
    annotations: { readOnlyHint: true },
  },
  () =>
    call<PeerInfo[]>('peers', {}, (peers) =>
      peers.length === 0
        ? 'No terminals.'
        : peers
            .map(
              (p) =>
                `- ${p.id} "${p.name}"${p.self ? ' (self)' : ''} — claude: ${p.claude ?? 'none'}${p.cwd ? ` — cwd: ${p.cwd}` : ''}`,
            )
            .join('\n'),
    ),
);

server.registerTool(
  'atelier_send',
  {
    title: 'Message a Claude session of this project',
    description:
      'Sends a message to the Claude session in another terminal of this project (or "all" of them). It is typed ' +
      'into that session as a prompt as soon as the session is idle; until then it waits in a queue. Use it to ' +
      'coordinate work (hand off a task, report a result, ask a question). Keep it self-contained.',
    inputSchema: {
      to: z.string().describe('Terminal id from atelier_peers, or "all" for every other Claude session in the project'),
      message: z.string().min(1).max(HUB_MAX_MESSAGE).describe('The message'),
    },
  },
  ({ to, message }) =>
    call<SendReport[]>('send', { to, message }, (reports) =>
      reports.map((r) => `${r.name || r.to}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join('\n'),
    ),
);

server.registerTool(
  'atelier_inbox',
  {
    title: 'Read messages',
    description:
      'Returns the messages other Claude sessions of this project sent you since the last call (including the ' +
      'ones already typed into your prompt). Messages still queued are delivered here instead of being typed later.',
  },
  () =>
    call<InboxMessage[]>('inbox', {}, (msgs) =>
      msgs.length === 0 ? 'No new messages.' : msgs.map((m) => `[${m.at}] ${m.fromName} (${m.from}): ${m.text}`).join('\n\n'),
    ),
);

server.registerTool(
  'atelier_read_output',
  {
    title: 'Read another terminal',
    description:
      'Returns the last lines shown by another terminal of this project (its screen and scrollback as text), e.g. a ' +
      'dev server log or a test run. Read-only.',
    inputSchema: {
      terminal: z.string().describe('Terminal id from atelier_peers'),
      lines: z.number().int().min(1).max(HUB_MAX_READ_LINES).default(100).describe('How many lines, from the end'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ terminal, lines }) => call<string>('read_output', { terminal, lines }, (t) => t || '(empty)'),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  console.error('atelier mcp:', err);
  process.exit(1);
});
