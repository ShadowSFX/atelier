import { HUB_MAX_MESSAGE, HUB_MAX_QUEUE, HUB_RATE_PER_MINUTE } from '@shared/constants';
import type { HookEvent, InboxMessage, PeerInfo, SendReport } from '@shared/hub';
import type { ClaudeAsk, ClaudeState, ClaudeStatus } from '@shared/ipc';

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
  /**
   * What a `waiting` session waits for. A permission prompt is answered with one key (Enter/Esc); a tool that asks
   * the user (questions, plan approval) can take several keys and ends with its PostToolUse hook.
   */
  waitFor: 'permission' | 'tool' | null;
  /** What the user is asked for while `waiting` (picks the notification): a permission or a question/plan/form. */
  ask: ClaudeAsk | null;
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
/** Tools that stop and wait for the user's answer (their PostToolUse comes once it is given). */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** Notifications that mean Claude needs an answer from the user. */
const ASKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

/** The session waits for a prompt: a message can be typed into it. */
const ready = (s: TerminalState) => s.claude === 'idle' || s.claude === 'done';

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
      s = { claude: null, waitFor: null, ask: null, typed: false, lastHookAt: 0, queue: [], inbox: [] };
      this.states.set(id, s);
    }
    return s;
  }

  claudeState(id: string): ClaudeState | null {
    return this.states.get(id)?.claude ?? null;
  }

  private publish(id: string): void {
    const s = this.state(id);
    this.deps.onStatus({
      terminalId: id,
      state: s.claude,
      queued: s.queue.length,
      ...(s.claude === 'waiting' && s.ask ? { asking: s.ask } : {}),
    });
  }

  hook(
    terminalId: string,
    event: HookEvent,
    notificationType?: string,
    at = this.deps.now(),
    tool?: string,
  ): void {
    const s = this.state(terminalId);
    if (at < s.lastHookAt) return;
    s.lastHookAt = at;
    const set = (
      state: ClaudeState | null,
      waitFor: TerminalState['waitFor'] = null,
      ask: ClaudeAsk | null = null,
    ) => {
      s.claude = state;
      s.waitFor = waitFor;
      s.ask = ask;
    };
    switch (event) {
      case 'SessionStart':
        set('idle');
        s.typed = false;
        break;
      case 'Stop':
        // A draft typed while Claude worked is still in the input box: `typed` stays as it is.
        set('done');
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
        set('busy');
        break;
      case 'PreToolUse':
        if (tool && ASKING_TOOLS.has(tool)) set('waiting', 'tool', 'question');
        else set('busy');
        break;
      case 'Notification':
        // A question already open stays one (its own notification must not make Enter end the wait early).
        if (notificationType && ASKING_NOTIFICATIONS.has(notificationType)) {
          if (s.claude === 'waiting' && s.waitFor === 'tool') set('waiting', 'tool', 'question');
          // An MCP server's form (elicitation) asks the user something; anything else asks for a permission.
          else
            set(
              'waiting',
              'permission',
              notificationType === 'elicitation_dialog' ? 'question' : 'permission',
            );
        }
        // Claude waits for a prompt: a turn interrupted with Esc never sends Stop, so `busy` would stay forever.
        else if (notificationType === 'idle_prompt' && s.claude === 'busy') set('idle');
        break;
      case 'SessionEnd':
        set(null);
        s.typed = false;
        break;
    }
    if (ready(s)) this.flush(terminalId);
    this.publish(terminalId);
  }

  /** Keyboard input from the user (not from an injection), in any state. */
  userInput(terminalId: string, data: string): void {
    const s = this.states.get(terminalId);
    if (!s?.claude || REPORT.test(data)) return;
    // Typing in a session whose finished turn was not looked at yet: the user is back.
    if (s.claude === 'done') {
      s.claude = 'idle';
      this.publish(terminalId);
    }
    if (CLEARS_LINE.test(data)) {
      s.typed = false;
      // Answering a permission prompt (Enter, Esc) lets Claude go on. A question or a plan approval may take
      // several keys: its PostToolUse hook says when it is answered.
      if (s.claude === 'waiting' && s.waitFor === 'permission') {
        s.claude = 'busy';
        s.waitFor = null;
        s.ask = null;
        this.publish(terminalId);
      }
      return;
    }
    s.typed = true;
  }

  /** The user looked at the terminal (focused it): a finished turn is no longer news. */
  seen(terminalId: string): void {
    const s = this.states.get(terminalId);
    if (s?.claude !== 'done') return;
    s.claude = 'idle';
    this.publish(terminalId);
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
    return this.deps
      .peersOf(projectId)
      .map((p) => ({ ...p, claude: this.claudeState(p.id), self: p.id === self }));
  }

  send(projectId: string, from: string, to: string, text: string): SendReport[] {
    const message = text.trim();
    const peers = this.deps.peersOf(projectId);
    const sender = peers.find((p) => p.id === from);
    if (!message) return [{ to, name: '', status: 'rejected', reason: 'empty message' }];
    if (message.length > HUB_MAX_MESSAGE) {
      return [
        { to, name: '', status: 'rejected', reason: `message longer than ${HUB_MAX_MESSAGE} characters` },
      ];
    }
    const targets =
      to === 'all'
        ? peers.filter((p) => p.id !== from && this.claudeState(p.id))
        : peers.filter((p) => p.id === to);
    if (targets.length === 0) {
      return [
        {
          to,
          name: '',
          status: 'rejected',
          reason:
            to === 'all' ? 'no other Claude session in this project' : 'no such terminal in this project',
        },
      ];
    }
    return targets.map((t) => this.sendOne(from, sender?.name ?? from, t.id, t.name, message));
  }

  private sendOne(from: string, fromName: string, to: string, toName: string, text: string): SendReport {
    if (to === from) return { to, name: toName, status: 'rejected', reason: 'cannot send to yourself' };
    const target = this.state(to);
    if (!target.claude)
      return { to, name: toName, status: 'rejected', reason: 'no Claude session runs in that terminal' };
    if (!this.allowRate(from, to)) {
      return {
        to,
        name: toName,
        status: 'rejected',
        reason: `rate limit: at most ${HUB_RATE_PER_MINUTE} messages per minute to the same session`,
      };
    }
    const msg: InboxMessage = {
      id: this.nextId++,
      from,
      fromName,
      text,
      at: new Date(this.deps.now()).toISOString(),
    };
    target.inbox.push(msg);
    if (target.inbox.length > MAX_INBOX) target.inbox.splice(0, target.inbox.length - MAX_INBOX);

    if (ready(target) && !target.typed && target.queue.length === 0 && this.inject(to, msg)) {
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
   * busy session or a draft, but never a session waiting for an answer: the text and Enter would answer it.
   */
  flush(terminalId: string, force = false): void {
    const s = this.states.get(terminalId);
    if (!s || s.queue.length === 0 || !s.claude || s.claude === 'waiting') return;
    if (!force && (!ready(s) || s.typed)) return;
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
    s.waitFor = null;
    setTimeout(() => this.deps.write(terminalId, '\r'), SUBMIT_DELAY_MS);
    return true;
  }
}

function format(m: InboxMessage): string {
  return `[Atelier message from "${m.fromName}" (terminal ${m.from})] ${m.text}\n(Reply with the atelier_send tool, to: "${m.from}".)`;
}
