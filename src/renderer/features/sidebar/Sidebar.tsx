import {
  Add16Regular,
  ArrowClockwise16Regular,
  Branch16Regular,
  ChevronDown12Regular,
  Dismiss12Regular,
  Rename16Regular,
  Sparkle12Filled,
  SplitVertical16Regular,
  SquareMultiple16Regular,
} from '@fluentui/react-icons';
import { memo, useState } from 'react';
import type { TerminalSpec } from '@shared/workspace';
import { cx, IconButton } from '../../components/Button';
import { ColorSwatches } from '../../components/Overlays';
import { api } from '../../lib/api';
import { bytes, percent, shortPath } from '../../lib/format';
import { openMenu, promptDialog, t, useApp, useT } from '../../state/app';
import { useRuntime } from '../../state/runtime';
import {
  activeProject,
  closeTerminal,
  duplicateTerminal,
  dropOnColumn,
  moveTerminal,
  newTerminalInActive,
  renameTerminal,
  selectTerminal,
  updateTerminal,
  useWorkspace,
} from '../../state/workspace';
import { restartTerminal } from '../../terminal/registry';
import s from './Sidebar.module.css';

export const TERMINAL_DRAG = 'application/x-atelier-terminal';

function terminalMenu(term: TerminalSpec, x: number, y: number): void {
  openMenu(x, y, [
    {
      label: t('terminals.rename'),
      icon: <Rename16Regular />,
      shortcut: 'F2',
      run: () => void renameFlow(term),
    },
    { label: t('terminals.color'), custom: <ColorSwatches value={term.color} onPick={(color) => updateTerminal(term.id, { color })} /> },
    'separator',
    { label: t('terminals.splitRight'), icon: <SplitVertical16Regular />, run: () => openRight(term.id) },
    { label: t('terminals.duplicate'), icon: <SquareMultiple16Regular />, run: () => duplicateTerminal(term.id) },
    { label: t('terminals.restart'), icon: <ArrowClockwise16Regular />, run: () => restartTerminal(term.id) },
    'separator',
    { label: t('terminals.close'), icon: <Dismiss12Regular />, shortcut: 'Ctrl+Shift+W', danger: true, run: () => void closeTerminal(term.id) },
  ]);
}

async function renameFlow(term: TerminalSpec): Promise<void> {
  const name = await promptDialog({ title: t('terminals.rename'), value: term.name, ok: t('common.rename') });
  if (name) renameTerminal(term.id, name);
}

function openRight(id: string): void {
  const p = activeProject();
  if (!p) return;
  const last = Math.max(0, p.layout.columns.length - 1);
  dropOnColumn(id, last, 'right');
}

function profileMenu(x: number, y: number): void {
  const { profiles, defaultProfileId } = useApp.getState();
  openMenu(
    x,
    y,
    profiles.map((p) => ({
      label: p.name,
      checked: p.id === defaultProfileId,
      run: () => newTerminalInActive({ profileId: p.id }),
    })),
  );
}

function ClaudeBadge({ id }: { id: string }) {
  const tr = useT();
  const status = useRuntime((st) => st.claude[id]);
  if (!status?.state) return null;
  const label = tr(status.state === 'idle' ? 'claude.idle' : status.state === 'busy' ? 'claude.busy' : 'claude.permission');
  return (
    <button
      type="button"
      className={cx(s.claude, s[`claude${status.state}`])}
      title={status.queued > 0 ? `${label} · ${tr('claude.queued', status.queued)}` : label}
      onClick={(e) => {
        e.stopPropagation();
        if (status.queued > 0) void api.invoke('claude:deliver-now', id);
      }}
    >
      <Sparkle12Filled />
      Claude
      {status.queued > 0 && <span className={s.queued}>{status.queued}</span>}
    </button>
  );
}

const Row = memo(function Row({
  term,
  focused,
  visible,
  index,
  drop,
  onDrop,
}: {
  term: TerminalSpec;
  focused: boolean;
  visible: boolean;
  index: number;
  drop: 'above' | 'below' | null;
  onDrop: (i: number | null, side?: 'above' | 'below') => void;
}) {
  const rt = useRuntime((st) => st.terminals[term.id]);
  const usage = useRuntime((st) => st.byTerminal[term.id]);
  const home = useApp((st) => st.home);
  const [dragging, setDragging] = useState(false);
  const progress = rt?.progress && rt.progress.state !== 0 ? rt.progress : null;

  return (
    <div
      role="option"
      aria-selected={focused}
      tabIndex={0}
      className={cx(s.row, visible && s.visible, focused && s.focused, dragging && s.dragging, drop === 'above' && s.dropAbove, drop === 'below' && s.dropBelow)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TERMINAL_DRAG, term.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
        // Panes show their drop zones while a terminal is dragged.
        requestAnimationFrame(() => useApp.setState({ dragTerminalId: term.id }));
      }}
      onDragEnd={() => {
        setDragging(false);
        useApp.setState({ dragTerminalId: null });
        onDrop(null);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TERMINAL_DRAG)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDrop(index, e.clientY < r.top + r.height / 2 ? 'above' : 'below');
      }}
      onClick={() => selectTerminal(term.id)}
      onDoubleClick={() => void renameFlow(term)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') selectTerminal(term.id);
        else if (e.key === 'F2') void renameFlow(term);
        else if (e.key === 'Delete') void closeTerminal(term.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        terminalMenu(term, e.clientX, e.clientY);
      }}
      title={term.lastCwd ?? undefined}
    >
      <span className={s.bar} style={term.color ? { background: term.color } : undefined} />
      <span className={s.name}>{term.name}</span>
      <span className={s.meta}>
        {usage?.foreground ? (
          <span className={cx(s.metaItem, s.proc)}>{usage.foreground}</span>
        ) : rt?.status === 'exited' ? (
          <span className={cx(s.metaItem, s.exited)}>{t('term.exited', rt.exitCode ?? 0).replace(/\.$/, '')}</span>
        ) : null}
        {term.lastCwd && <span className={cx(s.metaItem, s.cwd)}>{shortPath(term.lastCwd, home)}</span>}
        {rt?.branch && (
          <span className={s.metaItem}>
            <Branch16Regular fontSize={12} />
            {rt.branch}
          </span>
        )}
      </span>
      <span className={s.side}>
        <span className={s.badges}>
          <ClaudeBadge id={term.id} />
          {rt?.activity && !visible && <span className={s.activity} title="Output" />}
        </span>
        {usage && (
          <span className={s.usage} title={t('status.termTip')}>
            <span>{percent(usage.cpu)}</span> <span>{bytes(usage.memory)}</span>
          </span>
        )}
      </span>
      {progress && (
        <span className={cx(s.progress, progress.state === 2 && s.progressError, progress.state === 3 && s.progressIndeterminate)}>
          <span style={progress.state === 3 ? undefined : { width: `${progress.value}%` }} />
        </span>
      )}
    </div>
  );
});

export function Sidebar() {
  const tr = useT();
  const project = useWorkspace((w) => activeProject(w));
  const [drop, setDrop] = useState<{ index: number; side: 'above' | 'below' } | null>(null);

  if (!project) return <aside className={s.sidebar} />;
  const visible = new Set(project.layout.columns.map((c) => c.terminalId));
  const focusedId = project.layout.columns[project.layout.active]?.terminalId;

  return (
    <aside className={s.sidebar} aria-label={tr('terminals.title')}>
      <div className={s.header}>
        <span className={s.title}>{tr('terminals.title')}</span>
        <span className={s.newGroup}>
          <IconButton label={`${tr('terminals.new')} (Ctrl+Shift+T)`} size="sm" onClick={() => newTerminalInActive()}>
            <Add16Regular />
          </IconButton>
          <IconButton
            label={tr('terminals.newWith')}
            size="sm"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              profileMenu(r.left, r.bottom + 4);
            }}
          >
            <ChevronDown12Regular />
          </IconButton>
        </span>
      </div>
      <div
        className={s.list}
        role="listbox"
        aria-label={tr('terminals.title')}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(TERMINAL_DRAG);
          if (id && drop) {
            const from = project.terminals.findIndex((x) => x.id === id);
            let to = drop.side === 'above' ? drop.index : drop.index + 1;
            if (from < to) to -= 1;
            moveTerminal(id, to);
          }
          setDrop(null);
        }}
      >
        {project.terminals.map((term, i) => (
          <Row
            key={term.id}
            term={term}
            index={i}
            focused={term.id === focusedId}
            visible={visible.has(term.id)}
            drop={drop?.index === i ? drop.side : null}
            onDrop={(index, side) => setDrop(index === null || !side ? null : { index, side })}
          />
        ))}
        {project.terminals.length === 0 && <div className={s.empty}>{tr('terminals.empty')}</div>}
      </div>
    </aside>
  );
}
