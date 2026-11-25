import { create } from 'zustand';
import type { ClaudeStatus, StatsSnapshot, TerminalStats } from '@shared/ipc';
import type { ShellKind } from '@shared/shell';
import { api } from '../lib/api';

/** Live state of a terminal (not persisted). */
export interface TerminalRuntime {
  status: 'idle' | 'starting' | 'running' | 'exited' | 'failed';
  exitCode?: number;
  error?: string;
  kind?: ShellKind;
  distro?: string;
  /** Window title set by the program (OSC 0/2). */
  title?: string;
  /** The shell printed something (WSL can take seconds to boot: the pane says it is starting until then). */
  ready?: boolean;
  /** Output arrived while the terminal was not visible. */
  activity: boolean;
  /** OSC 9;4 progress: state 0 none, 1 value, 2 error, 3 indeterminate, 4 paused. */
  progress?: { state: number; value: number };
  /** Git branch reported by Atelier's prompt (OSC 633 P GitBranch). */
  branch?: string;
}

interface RuntimeState {
  terminals: Record<string, TerminalRuntime>;
  claude: Record<string, ClaudeStatus>;
  stats: StatsSnapshot | null;
  cpuHistory: number[];
  byTerminal: Record<string, TerminalStats>;
}

export const useRuntime = create<RuntimeState>(() => ({
  terminals: {},
  claude: {},
  stats: null,
  cpuHistory: [],
  byTerminal: {},
}));

const EMPTY: TerminalRuntime = { status: 'idle', activity: false };

export function patchRuntime(id: string, patch: Partial<TerminalRuntime>): void {
  useRuntime.setState((s) => {
    const prev = s.terminals[id] ?? EMPTY;
    const next = { ...prev, ...patch };
    // Avoid re-rendering subscribers when nothing changed (activity/progress fire often).
    if (Object.keys(patch).every((k) => prev[k as keyof TerminalRuntime] === next[k as keyof TerminalRuntime])) return s;
    return { terminals: { ...s.terminals, [id]: next } };
  });
}

export function dropRuntime(id: string): void {
  useRuntime.setState((s) => {
    const terminals = { ...s.terminals };
    const claude = { ...s.claude };
    delete terminals[id];
    delete claude[id];
    return { terminals, claude };
  });
}

export function runtimeOf(id: string): TerminalRuntime {
  return useRuntime.getState().terminals[id] ?? EMPTY;
}

export function initRuntimeEvents(): void {
  api.on('claude:status', (status) =>
    useRuntime.setState((s) => ({ claude: { ...s.claude, [status.terminalId]: status } })),
  );
  api.on('stats:update', (stats) =>
    useRuntime.setState((s) => ({
      stats,
      cpuHistory: [...s.cpuHistory.slice(-29), stats.cpu],
      byTerminal: Object.fromEntries(stats.terminals.map((t) => [t.terminalId, t])),
    })),
  );
}
