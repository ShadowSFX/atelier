import {
  Add16Regular,
  Dismiss12Regular,
  Folder16Regular,
  FolderOpen16Regular,
  Rename16Regular,
  Search16Regular,
  Settings16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import type { Project } from '@shared/workspace';
import { cx, IconButton } from '../../components/Button';
import { Logo } from '../../components/Logo';
import { ColorSwatches } from '../../components/Overlays';
import { api } from '../../lib/api';
import { openMenu, promptDialog, t, useApp, useT } from '../../state/app';
import { useRuntime } from '../../state/runtime';
import {
  activateProject,
  addProject,
  closeProject,
  moveProject,
  pickAndAddProject,
  renameProject,
  setProjectColor,
  useWorkspace,
} from '../../state/workspace';
import s from './TitleBar.module.css';

const PROJECT_DRAG = 'application/x-atelier-project';

function projectMenu(p: Project, x: number, y: number): void {
  openMenu(x, y, [
    {
      label: t('projects.rename'),
      icon: <Rename16Regular />,
      run: () =>
        void promptDialog({ title: t('projects.rename'), value: p.name, ok: t('common.rename') }).then(
          (name) => name && renameProject(p.id, name),
        ),
    },
    {
      label: t('projects.color'),
      custom: <ColorSwatches value={p.color} onPick={(c) => setProjectColor(p.id, c)} />,
    },
    {
      label: t('projects.reveal'),
      icon: <FolderOpen16Regular />,
      run: () => void api.invoke('shell:open-path', p.path),
    },
    'separator',
    {
      label: t('projects.close'),
      icon: <Dismiss12Regular />,
      danger: true,
      run: () => void closeProject(p.id),
    },
  ]);
}

/** Whether any terminal of a background project needs a look (output, or Claude waiting for permission). */
function useAttention(p: Project, active: boolean): 'activity' | 'claude' | null {
  return useRuntime((st) => {
    if (active) return null;
    if (p.terminals.some((x) => st.claude[x.id]?.state === 'waiting')) return 'claude';
    return p.terminals.some((x) => st.terminals[x.id]?.activity) ? 'activity' : null;
  });
}

function ProjectTab({
  p,
  active,
  index,
  dropBefore,
  onDropIndex,
}: {
  p: Project;
  active: boolean;
  index: number;
  dropBefore: boolean;
  onDropIndex: (i: number | null) => void;
}) {
  const tr = useT();
  const attention = useAttention(p, active);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={p.path}
      className={cx(s.tab, active && s.active, dropBefore && s.dropBefore)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT_DRAG, p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PROJECT_DRAG)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDropIndex(e.clientX < r.left + r.width / 2 ? index : index + 1);
      }}
      onPointerDown={(e) => e.button === 0 && activateProject(p.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && activateProject(p.id)}
      onAuxClick={(e) => e.button === 1 && void closeProject(p.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        projectMenu(p, e.clientX, e.clientY);
      }}
    >
      {p.color && <span className={s.stripe} style={{ background: p.color }} />}
      <span className={s.tabIcon}>
        <Folder16Regular />
        {attention && <span className={cx(s.dot, attention === 'claude' && s.dotAttention)} />}
      </span>
      <span className={s.name}>{p.name}</span>
      <IconButton
        label={tr('projects.close')}
        size="sm"
        className={s.close}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void closeProject(p.id)}
      >
        <Dismiss12Regular />
      </IconButton>
    </div>
  );
}

export function TitleBar() {
  const t = useT();
  const projects = useWorkspace((w) => w.projects);
  const activeId = useWorkspace((w) => w.activeProjectId);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(PROJECT_DRAG);
    if (id && dropIndex !== null) {
      const from = projects.findIndex((p) => p.id === id);
      moveProject(id, from < dropIndex ? dropIndex - 1 : dropIndex);
    } else {
      // A folder dropped from the file manager becomes a project.
      for (const f of e.dataTransfer.files) {
        const path = api.pathForFile(f);
        if (path) void addProject(path);
      }
    }
    setDropIndex(null);
  };

  return (
    <header
      className={s.bar}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PROJECT_DRAG) || e.dataTransfer.types.includes('Files'))
          e.preventDefault();
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropIndex(null)}
      onDrop={onDrop}
    >
      <div className={s.brand} title="Atelier">
        <Logo />
      </div>
      <div className={s.tabs} role="tablist" aria-label="Projects">
        {projects.map((p, i) => (
          <ProjectTab
            key={p.id}
            p={p}
            index={i}
            active={p.id === activeId}
            dropBefore={dropIndex === i}
            onDropIndex={setDropIndex}
          />
        ))}
        {dropIndex === projects.length && (
          <span className={s.dropBefore} style={{ position: 'relative', width: 0, height: 22 }} />
        )}
      </div>
      <IconButton
        label={`${t('projects.add')} (Ctrl+Shift+O)`}
        className={s.add}
        onClick={() => void pickAndAddProject()}
      >
        <Add16Regular />
      </IconButton>
      <div className={s.spacer} />
      <button type="button" className={s.search} onClick={() => useApp.setState({ paletteOpen: true })}>
        <Search16Regular />
        <span className={s.searchText}>{t('titlebar.search')}</span>
        <span className={s.kbd}>Ctrl Shift P</span>
      </button>
      <div className={s.tools}>
        <IconButton
          label={`${t('settings.title')} (Ctrl+,)`}
          onClick={() => useApp.setState({ settingsOpen: true })}
        >
          <Settings16Regular />
        </IconButton>
      </div>
    </header>
  );
}
