import { create } from 'zustand';
import {
  baseName,
  closeColumn as closeColumnOp,
  dropTerminal as dropTerminalOp,
  EMPTY_WORKSPACE,
  pathIdentity,
  removeTerminalFromLayout,
  resizeColumns as resizeColumnsOp,
  showTerminal,
  splitRight,
  type DropSide,
  type Project,
  type ProjectLayout,
  type TerminalSpec,
  type Workspace,
} from '@shared/workspace';
import { MAX_COLUMNS } from '@shared/constants';
import { api } from '../lib/api';
import { disposeTerminal, focusTerminal, startTerminal } from '../terminal/registry';
import { confirmDialog, t, toast, useApp } from './app';

export const useWorkspace = create<Workspace>(() => EMPTY_WORKSPACE);

export const newId = (prefix: string) => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

// ───────────── Selectors ─────────────

export function activeProject(ws: Workspace = useWorkspace.getState()): Project | null {
  return ws.projects.find((p) => p.id === ws.activeProjectId) ?? null;
}

export function findTerminal(
  id: string,
  ws: Workspace = useWorkspace.getState(),
): { project: Project; terminal: TerminalSpec } | null {
  for (const project of ws.projects) {
    const terminal = project.terminals.find((t) => t.id === id);
    if (terminal) return { project, terminal };
  }
  return null;
}

/** The terminal in the focused column of the active project. */
export function focusedTerminalId(ws: Workspace = useWorkspace.getState()): string | null {
  const p = activeProject(ws);
  return p?.layout.columns[p.layout.active]?.terminalId ?? null;
}

// ───────────── Mutations ─────────────

function updateProject(id: string, fn: (p: Project) => Project): void {
  useWorkspace.setState((ws) => ({ projects: ws.projects.map((p) => (p.id === id ? fn(p) : p)) }));
}

function setLayout(projectId: string, fn: (l: ProjectLayout, p: Project) => ProjectLayout): void {
  updateProject(projectId, (p) => ({ ...p, layout: fn(p.layout, p) }));
}

/** Starts the shells of a project (terminals of other projects start when their project is first opened). */
function startProject(project: Project): void {
  for (const term of project.terminals) startTerminal(term.id);
}

export async function loadWorkspace(): Promise<void> {
  useWorkspace.setState(await api.invoke('workspace:load'), true);
  let timer = 0;
  useWorkspace.subscribe(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void api.invoke('workspace:save', useWorkspace.getState()), 150);
  });
  const p = activeProject();
  if (p) startProject(p);
  api.on('app:open-project', (path) => void addProject(path));
}

/** Saves right away (before quitting). */
export function saveWorkspaceNow(): Promise<void> {
  return api.invoke('workspace:save', useWorkspace.getState());
}

export function activateProject(id: string): void {
  const project = useWorkspace.getState().projects.find((p) => p.id === id);
  if (!project) return;
  useWorkspace.setState({ activeProjectId: id });
  startProject(project);
  const focused = focusedTerminalId();
  if (focused) focusTerminal(focused);
}

export async function addProject(path: string): Promise<void> {
  const info = await api.invoke('fs:info', path);
  if (!info.exists || !info.isDirectory) {
    toast(info.exists ? t('projects.notFolder') : t('projects.missing', path), 'error');
    return;
  }
  const key = pathIdentity(path);
  const existing = useWorkspace.getState().projects.find((p) => pathIdentity(p.path) === key);
  if (existing) {
    activateProject(existing.id);
    return;
  }
  const project: Project = {
    id: newId('p'),
    name: baseName(path),
    path,
    color: null,
    terminals: [],
    layout: { columns: [], active: 0 },
  };
  useWorkspace.setState((ws) => ({ projects: [...ws.projects, project], activeProjectId: project.id }));
  newTerminal(project.id);
}

export async function pickAndAddProject(): Promise<void> {
  const path = await api.invoke('dialog:pick-folder', t('projects.addTitle'));
  if (path) await addProject(path);
}

export async function closeProject(id: string): Promise<void> {
  const project = useWorkspace.getState().projects.find((p) => p.id === id);
  if (!project) return;
  if (project.terminals.length > 0) {
    const ok = await confirmDialog({
      title: t('projects.closeConfirm', project.name, project.terminals.length),
      ok: t('projects.close'),
      danger: true,
    });
    if (!ok) return;
  }
  for (const term of project.terminals) disposeTerminal(term.id, true);
  useWorkspace.setState((ws) => {
    const index = ws.projects.findIndex((p) => p.id === id);
    const projects = ws.projects.filter((p) => p.id !== id);
    const activeProjectId =
      ws.activeProjectId === id
        ? (projects[Math.min(index, projects.length - 1)]?.id ?? null)
        : ws.activeProjectId;
    return { projects, activeProjectId };
  });
  const next = activeProject();
  if (next) activateProject(next.id);
}

export function renameProject(id: string, name: string): void {
  const clean = name.trim();
  if (clean) updateProject(id, (p) => ({ ...p, name: clean }));
}

export function setProjectColor(id: string, color: string | null): void {
  updateProject(id, (p) => ({ ...p, color }));
}

export function moveProject(id: string, toIndex: number): void {
  useWorkspace.setState((ws) => {
    const from = ws.projects.findIndex((p) => p.id === id);
    if (from < 0) return ws;
    const projects = [...ws.projects];
    const [moved] = projects.splice(from, 1);
    projects.splice(Math.max(0, Math.min(projects.length, toIndex)), 0, moved!);
    return { projects };
  });
}

export function cycleProject(delta: number): void {
  const ws = useWorkspace.getState();
  if (ws.projects.length < 2) return;
  const i = ws.projects.findIndex((p) => p.id === ws.activeProjectId);
  const next = ws.projects[(i + delta + ws.projects.length) % ws.projects.length]!;
  activateProject(next.id);
}

// ───────────── Terminals ─────────────

function uniqueName(project: Project, base: string): string {
  const names = new Set(project.terminals.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function newTerminal(
  projectId: string,
  o: { profileId?: string; split?: boolean; color?: string | null; cwd?: string | null; name?: string } = {},
): string | null {
  const project = useWorkspace.getState().projects.find((p) => p.id === projectId);
  if (!project) return null;
  const app = useApp.getState();
  const profileId = o.profileId || app.defaultProfileId;
  const profile = app.profiles.find((p) => p.id === profileId);
  const spec: TerminalSpec = {
    id: newId('t'),
    name: uniqueName(
      project,
      o.name ?? profile?.name ?? t('terminals.defaultName', project.terminals.length + 1),
    ),
    color: o.color ?? null,
    profileId,
    lastCwd: o.cwd ?? null,
  };
  updateProject(projectId, (p) => {
    const layout =
      o.split && p.layout.columns.length < MAX_COLUMNS
        ? splitRight(p.layout, spec.id)
        : showTerminal(p.layout, spec.id);
    return { ...p, terminals: [...p.terminals, spec], layout };
  });
  if (useWorkspace.getState().activeProjectId !== projectId)
    useWorkspace.setState({ activeProjectId: projectId });
  startTerminal(spec.id);
  focusTerminal(spec.id);
  return spec.id;
}

export function newTerminalInActive(o: Parameters<typeof newTerminal>[1] = {}): void {
  const p = activeProject();
  if (p) newTerminal(p.id, o);
}

export function duplicateTerminal(id: string): void {
  const found = findTerminal(id);
  if (!found) return;
  const { project, terminal } = found;
  newTerminal(project.id, {
    profileId: terminal.profileId,
    color: terminal.color,
    cwd: terminal.lastCwd,
    name: terminal.name,
    split: true,
  });
}

export async function closeTerminal(id: string): Promise<void> {
  const found = findTerminal(id);
  if (!found) return;
  if (useApp.getState().settings.confirmCloseRunning) {
    const busy = await api.invoke('pty:busy', [id]);
    if (busy.length > 0) {
      const ok = await confirmDialog({
        title: t('terminals.closeRunning', found.terminal.name),
        ok: t('terminals.close'),
        danger: true,
      });
      if (!ok) return;
    }
  }
  disposeTerminal(id, true);
  updateProject(found.project.id, (p) => {
    const terminals = p.terminals.filter((x) => x.id !== id);
    return { ...p, terminals, layout: removeTerminalFromLayout(p.layout, id, terminals) };
  });
  const focused = focusedTerminalId();
  if (focused) focusTerminal(focused);
}

export function updateTerminal(id: string, patch: Partial<Omit<TerminalSpec, 'id'>>): void {
  const found = findTerminal(id);
  if (!found) return;
  updateProject(found.project.id, (p) => ({
    ...p,
    terminals: p.terminals.map((x) => (x.id === id ? { ...x, ...patch } : x)),
  }));
}

export function renameTerminal(id: string, name: string): void {
  const clean = name.trim();
  if (clean) updateTerminal(id, { name: clean });
}

export function moveTerminal(id: string, toIndex: number): void {
  const found = findTerminal(id);
  if (!found) return;
  updateProject(found.project.id, (p) => {
    const terminals = [...p.terminals];
    const from = terminals.findIndex((x) => x.id === id);
    const [moved] = terminals.splice(from, 1);
    terminals.splice(Math.max(0, Math.min(terminals.length, toIndex)), 0, moved!);
    return { ...p, terminals };
  });
}

/** Shows a terminal (focusing its column if visible, else in the focused column). */
export function selectTerminal(id: string): void {
  const found = findTerminal(id);
  if (!found) return;
  if (useWorkspace.getState().activeProjectId !== found.project.id) activateProject(found.project.id);
  setLayout(found.project.id, (l) => showTerminal(l, id));
  focusTerminal(id);
}

export function cycleTerminal(delta: number): void {
  const p = activeProject();
  if (!p || p.terminals.length === 0) return;
  const current = focusedTerminalId();
  const i = p.terminals.findIndex((x) => x.id === current);
  selectTerminal(p.terminals[(i + delta + p.terminals.length) % p.terminals.length]!.id);
}

export function dropOnColumn(terminalId: string, column: number, side: DropSide): void {
  const p = activeProject();
  if (!p || !p.terminals.some((x) => x.id === terminalId)) return;
  if (
    side !== 'center' &&
    p.layout.columns.length >= MAX_COLUMNS &&
    !p.layout.columns.some((c) => c.terminalId === terminalId)
  ) {
    toast(t('pane.full'));
    return;
  }
  setLayout(p.id, (l) => dropTerminalOp(l, terminalId, column, side));
  focusTerminal(terminalId);
}

export function splitActive(): void {
  const p = activeProject();
  if (!p) return;
  if (p.layout.columns.length >= MAX_COLUMNS) {
    toast(t('pane.full'));
    return;
  }
  // Prefer a terminal that isn't visible; otherwise open a new one.
  const visible = new Set(p.layout.columns.map((c) => c.terminalId));
  const hidden = p.terminals.find((x) => !visible.has(x.id));
  if (hidden) {
    setLayout(p.id, (l) => splitRight(l, hidden.id));
    focusTerminal(hidden.id);
  } else {
    newTerminal(p.id, { split: true });
  }
}

export function closeColumn(index: number): void {
  const p = activeProject();
  if (!p) return;
  setLayout(p.id, (l) => closeColumnOp(l, index));
  const focused = focusedTerminalId();
  if (focused) focusTerminal(focused);
}

export function focusColumn(index: number): void {
  const p = activeProject();
  const col = p?.layout.columns[index];
  if (!p || !col) return;
  if (p.layout.active !== index) setLayout(p.id, (l) => ({ ...l, active: index }));
  focusTerminal(col.terminalId);
}

export function cycleColumn(delta: number): void {
  const p = activeProject();
  if (!p || p.layout.columns.length < 2) return;
  focusColumn((p.layout.active + delta + p.layout.columns.length) % p.layout.columns.length);
}

export function resizeColumns(index: number, delta: number): void {
  const p = activeProject();
  if (p) setLayout(p.id, (l) => resizeColumnsOp(l, index, delta));
}

export function setLastCwd(id: string, cwd: string): void {
  const found = findTerminal(id);
  if (found && found.terminal.lastCwd !== cwd) updateTerminal(id, { lastCwd: cwd });
}
