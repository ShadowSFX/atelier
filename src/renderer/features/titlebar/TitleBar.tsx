import {
  Add16Regular,
  Delete16Regular,
  Dismiss12Regular,
  Folder16Regular,
  FolderOpen16Regular,
  Rename16Regular,
  Search16Regular,
  Settings16Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import { projectClaudeState, type ProjectClaudeState } from '@shared/claude';
import type { Project } from '@shared/workspace';
import { cx, IconButton } from '../../components/Button';
import { CLAUDE_LABEL, ClaudeGlyph } from '../../components/ClaudeGlyph';
import { Logo } from '../../components/Logo';
import { LIBRARY_DRAG } from '../library/ProjectCard';
import { openLibrary, toggleLibrary, useLibraryView } from '../../state/library';
import { ColorSwatches } from '../../components/Overlays';
import { api } from '../../lib/api';
import { openMenu, promptDialog, t, useApp, useT } from '../../state/app';
import { useRuntime } from '../../state/runtime';
import {
  activateProject,
  addProject,
  closeProject,
  moveProject,
  openFromLibrary,
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
      run: () => void closeProject(p.id),
    },
    {
      label: t('projects.closeForget'),
      icon: <Delete16Regular />,
      danger: true,
      run: () => void closeProject(p.id, { forget: true }),
    },
  ]);
}

/** Whether a background project printed output since it was last shown (Claude's state has its own glyph). */
function useActivity(p: Project, active: boolean): boolean {
  return useRuntime((st) => !active && p.terminals.some((x) => st.terminals[x.id]?.activity));
}

/** The most urgent state among the project's Claude sessions (waiting > busy > done), on every tab. */
function useClaudeState(p: Project): ProjectClaudeState | null {
  return useRuntime((st) => projectClaudeState(p.terminals.map((x) => st.claude[x.id]?.state)));
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
  const activity = useActivity(p, active);
  const claude = useClaudeState(p);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={claude ? `${p.path}\n${tr('claude.tip', tr(CLAUDE_LABEL[claude]))}` : p.path}
      data-claude-state={claude ?? undefined}
      className={cx(s.tab, active && s.active, dropBefore && s.dropBefore)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT_DRAG, p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PROJECT_DRAG) && !e.dataTransfer.types.includes(LIBRARY_DRAG))
          return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDropIndex(e.clientX < r.left + r.width / 2 ? index : index + 1);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        activateProject(p.id);
        openLibrary(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        activateProject(p.id);
        openLibrary(false);
      }}
      onAuxClick={(e) => e.button === 1 && void closeProject(p.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        projectMenu(p, e.clientX, e.clientY);
      }}
    >
      {p.color && <span className={s.stripe} style={{ background: p.color }} />}
      <span className={s.tabIcon}>
        {claude ? <ClaudeGlyph state={claude} className={s.claudeGlyph} /> : <Folder16Regular />}
        {/* A working session always prints: the output dot would only blur Claude's glyph (and look like waiting). */}
        {activity && !claude && <span className={s.dot} />}
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
  const library = useLibraryView((v) => v.open);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(PROJECT_DRAG);
    const fromLibrary = e.dataTransfer.getData(LIBRARY_DRAG);
    if (id && dropIndex !== null) {
      const from = projects.findIndex((p) => p.id === id);
      moveProject(id, from < dropIndex ? dropIndex - 1 : dropIndex);
    } else if (fromLibrary) {
      // A library card dropped on the tabs opens there (or moves its tab there when it is already open).
      void openFromLibrary(fromLibrary, dropIndex ?? projects.length);
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
        if (
          e.dataTransfer.types.includes(PROJECT_DRAG) ||
          e.dataTransfer.types.includes(LIBRARY_DRAG) ||
          e.dataTransfer.types.includes('Files')
        ) {
          e.preventDefault();
          // Over the empty part of the bar: the end of the tabs.
          if (e.dataTransfer.types.includes(LIBRARY_DRAG) && e.target === e.currentTarget)
            setDropIndex(projects.length);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropIndex(null)}
      onDrop={onDrop}
    >
      <button
        type="button"
        className={cx(s.brand, library && s.brandOn)}
        title={`${t('library.title')} (Ctrl+Shift+L)`}
        aria-label={t('library.title')}
        aria-pressed={library}
        onClick={toggleLibrary}
      >
        <Logo />
      </button>
      <div className={s.tabs} role="tablist" aria-label="Projects">
        {projects.map((p, i) => (
          <ProjectTab
            key={p.id}
            p={p}
            index={i}
            active={p.id === activeId && !library}
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
