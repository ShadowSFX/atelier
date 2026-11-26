import {
  Dismiss12Regular,
  FolderAdd16Regular,
  SplitVertical16Regular,
  WindowConsole20Regular,
} from '@fluentui/react-icons';
import { useLayoutEffect, useRef, useState } from 'react';
import { MAX_COLUMNS } from '@shared/constants';
import type { DropSide, Project } from '@shared/workspace';
import { Button, cx, IconButton } from '../../components/Button';
import { api } from '../../lib/api';
import { shortPath } from '../../lib/format';
import { useApp, useT } from '../../state/app';
import { useRuntime } from '../../state/runtime';
import {
  activeProject,
  addProject,
  closeColumn,
  dropOnColumn,
  focusColumn,
  newTerminalInActive,
  pickAndAddProject,
  resizeColumns,
  splitActive,
  useWorkspace,
} from '../../state/workspace';
import { attachTerminal, getController, releaseTerminal } from '../../terminal/registry';
import type { TerminalController } from '../../terminal/TerminalController';
import { TERMINAL_DRAG } from '../sidebar/Sidebar';
import { SearchBar } from './SearchBar';
import { launch, LauncherIcon } from '../launch/launch';
import s from './PaneGrid.module.css';

function DropLayer({ index, full }: { index: number; full: boolean }) {
  const t = useT();
  const [zone, setZone] = useState<DropSide | null>(null);
  const zones: [DropSide, string][] = [
    ['left', t('pane.dropLeft')],
    ['center', t('pane.dropCenter')],
    ['right', t('pane.dropRight')],
  ];
  return (
    <div
      className={s.dropLayer}
      data-full={full}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setZone(null)}
    >
      {zones.map(([side, label]) => (
        <div
          key={side}
          className={cx(s.zone, side !== 'center' && s.zoneSide, zone === side && s.zoneOn)}
          data-label={side !== 'center' && full ? t('pane.full') : label}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TERMINAL_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setZone(side);
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(TERMINAL_DRAG);
            setZone(null);
            useApp.setState({ dragTerminalId: null });
            if (id) dropOnColumn(id, index, side);
          }}
        />
      ))}
    </div>
  );
}

function PaneSlot({ project, index, weight }: { project: Project; index: number; weight: number }) {
  const t = useT();
  const column = project.layout.columns[index]!;
  const term = project.terminals.find((x) => x.id === column.terminalId);
  const active = project.layout.active === index;
  const columns = project.layout.columns.length;
  const dragging = useApp((st) => st.dragTerminalId !== null);
  const home = useApp((st) => st.home);
  const body = useRef<HTMLDivElement>(null);
  const [ctrl, setCtrl] = useState<TerminalController | null>(null);
  const starting = useRuntime((st) => {
    const rt = st.terminals[column.terminalId];
    return !rt || ((rt.status === 'starting' || rt.status === 'running') && !rt.ready);
  });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    attachTerminal(column.terminalId, el);
    setCtrl(getController(column.terminalId) ?? null);
    return () => releaseTerminal(column.terminalId, el);
  }, [column.terminalId]);

  return (
    <section
      className={cx(s.pane, active && s.active, columns > 1 && s.multi)}
      style={{ flex: `${weight} 1 0` }}
      onPointerDownCapture={() => !active && focusColumn(index)}
      aria-label={term?.name}
    >
      <div className={s.header}>
        <span className={s.colorBar} style={term?.color ? { background: term.color } : undefined} />
        <span className={s.paneName}>{term?.name}</span>
        <span className={s.paneCwd} title={term?.lastCwd ?? project.path}>
          {/* rtl + bdi keeps the end of a long path visible */}
          <bdi>{shortPath(term?.lastCwd ?? project.path, home)}</bdi>
        </span>
        <span className={s.paneTools}>
          {columns < MAX_COLUMNS && (
            <IconButton label={`${t('pane.split')} (Ctrl+Shift+5)`} size="sm" onClick={() => splitActive()}>
              <SplitVertical16Regular />
            </IconButton>
          )}
          {columns > 1 && (
            <IconButton label={t('pane.close')} size="sm" onClick={() => closeColumn(index)}>
              <Dismiss12Regular />
            </IconButton>
          )}
        </span>
      </div>
      <div ref={body} className={s.body}>
        {ctrl && <SearchBar c={ctrl} />}
        {starting && <div className={s.starting}>{t('term.starting', term?.name ?? '')}</div>}
        {dragging && <DropLayer index={index} full={columns >= MAX_COLUMNS} />}
      </div>
    </section>
  );
}

function Splitter({
  index,
  container,
}: {
  index: number;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={cx(s.splitter, active && s.splitterActive)}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const width = container.current?.clientWidth ?? 1;
        let last = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        const move = (ev: PointerEvent) => {
          resizeColumns(index, (ev.clientX - last) / width);
          last = ev.clientX;
        };
        const up = () => {
          setActive(false);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function NoProject() {
  const t = useT();
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(s.empty, over && s.dropTarget)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        for (const f of e.dataTransfer.files) {
          const path = api.pathForFile(f);
          if (path) void addProject(path);
        }
      }}
    >
      <div className={s.emptyCard}>
        <h1 className={s.emptyTitle}>{t('projects.empty.title')}</h1>
        <p className={s.emptyText}>{t('projects.empty.body')}</p>
        <Button variant="primary" onClick={() => void pickAndAddProject()}>
          <FolderAdd16Regular />
          {t('projects.add')}
        </Button>
        <span className={s.emptyHint}>{t('projects.empty.drop')}</span>
      </div>
    </div>
  );
}

export function PaneGrid() {
  const t = useT();
  const project = useWorkspace((w) => activeProject(w));
  const container = useRef<HTMLDivElement>(null);

  if (!project) {
    return (
      <main className={s.sheet}>
        <NoProject />
      </main>
    );
  }
  const { columns } = project.layout;
  if (columns.length === 0) {
    return (
      <main className={s.sheet}>
        <div className={s.empty}>
          <div className={s.emptyCard}>
            <p className={s.emptyText}>
              {project.terminals.length === 0 ? t('terminals.empty') : t('pane.empty')}
            </p>
            <div className={s.emptyActions}>
              <Button variant="primary" onClick={() => newTerminalInActive()}>
                <WindowConsole20Regular fontSize={16} />
                {t('terminals.new')}
              </Button>
              <Button onClick={() => launch('claude')}>
                <LauncherIcon id="claude" />
                {t('launch.claude')}
              </Button>
            </div>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className={s.sheet} ref={container}>
      {columns.map((c, i) => (
        <PaneFragment
          key={c.terminalId}
          project={project}
          index={i}
          weight={c.weight}
          container={container}
        />
      ))}
    </main>
  );
}

function PaneFragment({
  project,
  index,
  weight,
  container,
}: {
  project: Project;
  index: number;
  weight: number;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {index > 0 && <Splitter index={index - 1} container={container} />}
      <PaneSlot project={project} index={index} weight={weight} />
    </>
  );
}
