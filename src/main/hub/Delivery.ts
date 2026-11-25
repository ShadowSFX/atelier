import { HUB_MAX_MESSAGE, HUB_MAX_QUEUE, HUB_RATE_PER_MINUTE } from '@shared/constants';
import type { HookEvent, InboxMessage, PeerInfo, SendReport } from '@shared/hub';
import type { ClaudeState, ClaudeStatus } from '@shared/ipc';

/** What the router needs from the rest of the app (injected so the logic is testable without PTYs). */
export interface DeliveryDeps {
  /** Terminals of a project that are running, with their display data. */
  peersOf(projectId: string): { id: string; name: string; color: string | null; cwd: string | null }[];
  /** Writes to the terminal's PTY; false when it is gone. */
  write(terminalId: string, data: string): boolean;
  onStatus(status: ClaudeStatus): void;
  now(): number;
}

interface TerminalState {
  claude: ClaudeState | null;
  /** The user typed into this terminal since Claude last became idle: injecting now would mix with their text. */
  typed: boolean;
  /** Start time of the last hook applied (async hooks may arrive late). */
  lastHookAt: number;
  queue: InboxMessage[];
  inbox: InboxMessage[];
}

const MAX_INBOX = 200;
/* eslint-disable no-control-regex -- these match terminal control sequences on purpose */
/** Keys that submit or discard the input line: Enter, Esc, Ctrl+C, Ctrl+U. */
const CLEARS_LINE = /^(\r|\x1b|\x03|\x15)$/;
/** What xterm sends on its own (focus, mouse, device reports): not typing. */
const REPORT = /^\x1b\[(I|O|<[\d;]+[mM]|M[\s\S]{3}|[?>]?[\d;]*[cRn])$/;
/** Everything but newline and tab. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */
/** Claude Code reads a bracketed paste, then Enter submits it. A short gap keeps them separate events. */
const SUBMIT_DELAY_MS = 40;

/**
 * Routes messages between Claude sessions of the same project and tracks each session's state from its hooks.
 * A message is typed into the target's prompt right away when that session is idle and the user isn't typing
 * there; otherwise it waits in a queue until the session's next Stop (or the user delivers it by hand).
 * Every message is also kept in the target's inbox (atelier_inbox).
 */
export class Delivery {
  private readonly states = new Map<string, TerminalState>();
  private readonly sent = new Map<string, number[]>();
  private nextId = 1;

  constructor(private readonly deps: DeliveryDeps) {}

  private state(id: string): TerminalState {
    let s = this.states.get(id);
    if (!s) {
      s = { claude: null, typed: false, lastHookAt: 0, queue: [], inbox: [] };
      this.states.set(id, s);
    }
    return s;
  }

  claudeState(id: string): ClaudeState | null {
    return this.states.get(id)?.claude ?? null;
  }

  private publish(id: string): void {
    const s = this.state(id);
    this.deps.onStatus({ terminalId: id, state: s.claude, queued: s.queue.length });
  }

  hook(terminalId: string, event: HookEvent, notificationType?: string, at = this.deps.now()): void {
    const s = this.state(terminalId);
    if (at < s.lastHookAt) return;
    s.lastHookAt = at;
    switch (event) {
      case 'SessionStart':
        s.claude = 'idle';
        s.typed = false;
        break;
      case 'Stop':
        // A draft typed while Claude worked is still in the input box: `typed` stays as it is.
        s.claude = 'idle';
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
        s.claude = 'busy';
        break;
      case 'Notification':
        if (notificationType === 'permission_prompt') s.claude = 'permission';
        else if (notificationType === 'idle_prompt' && s.claude !== 'busy') s.claude = 'idle';
        break;
      case 'SessionEnd':
        s.claude = null;
        s.typed = false;
        break;
    }
    if (s.claude === 'idle') this.flush(terminalId);
    this.publish(terminalId);
  }

  /** Keyboard input from the user (not from an injection), in any state. */
  userInput(terminalId: string, data: string): void {
    const s = this.states.get(terminalId);
    if (!s?.claude || REPORT.test(data)) return;
    if (CLEARS_LINE.test(data)) {
      s.typed = false;
      // Answering a permission prompt (Enter, Esc) lets Claude go on.
      if (s.claude === 'permission') {
        s.claude = 'busy';
        this.publish(terminalId);
      }
      return;
    }
    s.typed = true;
  }

  /**
   * The shell drew its prompt again (OSC 133;A): whatever Claude session ran in this terminal is over, even if it
   * died without a SessionEnd hook. Nothing may be typed into the shell as if it were Claude.
   */
  shellPrompt(terminalId: string): void {
    if (this.states.get(terminalId)?.claude) this.terminalGone(terminalId);
  }

  terminalGone(terminalId: string): void {
    this.states.delete(terminalId);
    this.deps.onStatus({ terminalId, state: null, queued: 0 });
  }

  peers(projectId: string, self: string): PeerInfo[] {
    return this.deps.peersOf(projectId).map((p) => ({ ...p, claude: this.claudeState(p.id), self: p.id === self }));
  }

  send(projectId: string, from: string, to: string, text: string): SendReport[] {
    const message = text.trim();
    const peers = this.deps.peersOf(projectId);
    const sender = peers.find((p) => p.id === from);
    if (!message) return [{ to, name: '', status: 'rejected', reason: 'empty message' }];
    if (message.length > HUB_MAX_MESSAGE) {
      return [{ to, name: '', status: 'rejected', reason: `message longer than ${HUB_MAX_MESSAGE} characters` }];
    }
    const targets = to === 'all' ? peers.filter((p) => p.id !== from && this.claudeState(p.id)) : peers.filter((p) => p.id === to);
    if (targets.length === 0) {
      return [{ to, name: '', status: 'rejected', reason: to === 'all' ? 'no other Claude session in this project' : 'no such terminal in this project' }];
    }
    return targets.map((t) => this.sendOne(from, sender?.name ?? from, t.id, t.name, message));
  }

  private sendOne(from: string, fromName: string, to: string, toName: string, text: string): SendReport {
    if (to === from) return { to, name: toName, status: 'rejected', reason: 'cannot send to yourself' };
    const target = this.state(to);
    if (!target.claude) return { to, name: toName, status: 'rejected', reason: 'no Claude session runs in that terminal' };
    if (!this.allowRate(from, to)) {
      return { to, name: toName, status: 'rejected', reason: `rate limit: at most ${HUB_RATE_PER_MINUTE} messages per minute to the same session` };
    }
    const msg: InboxMessage = { id: this.nextId++, from, fromName, text, at: new Date(this.deps.now()).toISOString() };
    target.inbox.push(msg);
    if (target.inbox.length > MAX_INBOX) target.inbox.splice(0, target.inbox.length - MAX_INBOX);

    if (target.claude === 'idle' && !target.typed && target.queue.length === 0 && this.inject(to, msg)) {
      return { to, name: toName, status: 'delivered' };
    }
    if (target.queue.length >= HUB_MAX_QUEUE) {
      return { to, name: toName, status: 'rejected', reason: 'the session has too many queued messages' };
    }
    target.queue.push(msg);
    this.publish(to);
    return { to, name: toName, status: 'queued' };
  }

  private allowRate(from: string, to: string): boolean {
    const key = `${from}>${to}`;
    const now = this.deps.now();
    const times = (this.sent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= HUB_RATE_PER_MINUTE) {
      this.sent.set(key, times);
      return false;
    }
    times.push(now);
    this.sent.set(key, times);
    return true;
  }

  /**
   * Delivers queued messages, oldest first, merged into one prompt. `force` (the user clicked the badge) ignores a
   * busy session or a draft, but never a permission prompt: the text and Enter would answer it.
   */
  flush(terminalId: string, force = false): void {
    const s = this.states.get(terminalId);
    if (!s || s.queue.length === 0 || !s.claude || s.claude === 'permission') return;
    if (!force && (s.claude !== 'idle' || s.typed)) return;
    const batch = s.queue.splice(0);
    const merged: InboxMessage = { ...batch[0]!, text: batch.map((m) => format(m)).join('\n\n') };
    if (!this.inject(terminalId, merged, true)) s.queue.unshift(...batch);
    this.publish(terminalId);
  }

  /** Messages received since the last call. Queued ones read here are not typed into the prompt later. */
  inbox(terminalId: string): InboxMessage[] {
    const s = this.states.get(terminalId);
    if (!s) return [];
    const read = s.inbox.splice(0);
    if (s.queue.length > 0) {
      const ids = new Set(read.map((m) => m.id));
      s.queue = s.queue.filter((m) => !ids.has(m.id));
      this.publish(terminalId);
    }
    return read;
  }

  private inject(terminalId: string, msg: InboxMessage, preformatted = false): boolean {
    const text = preformatted ? msg.text : format(msg);
    // Bracketed paste: the text arrives as one block (newlines don't submit it); then Enter.
    // Control characters (ESC, C1 CSI, Ctrl+C/D/Z…) are removed so a message can't end the paste early or act as keys.
    const ok = this.deps.write(terminalId, `\x1b[200~${text.replace(CONTROL, '')}\x1b[201~`);
    if (!ok) return false;
    const s = this.state(terminalId);
    s.claude = 'busy'; // the prompt is being submitted; UserPromptSubmit confirms it
    setTimeout(() => this.deps.write(terminalId, '\r'), SUBMIT_DELAY_MS);
    return true;
  }
}

function format(m: InboxMessage): string {
  return `[Atelier message from "${m.fromName}" (terminal ${m.from})] ${m.text}\n(Reply with the atelier_send tool, to: "${m.from}".)`;
}
