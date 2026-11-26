import {
  Add16Regular,
  ArrowSync16Regular,
  FolderAdd16Regular,
  Grid16Regular,
  Search16Regular,
  Settings16Regular,
  SplitVertical16Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../components/Button';
import { LAUNCHERS } from '@shared/launchers';
import { shortPath } from '../../lib/format';
import { checkForUpdates, useApp, useT } from '../../state/app';
import { openLibrary, useLibrary } from '../../state/library';
import {
  activateProject,
  newTerminalInActive,
  openFromLibrary,
  pickAndAddProject,
  selectTerminal,
  splitActive,
  useWorkspace,
} from '../../state/workspace';
import { launch, LauncherIcon, openSessionPicker, ResumeIcon } from '../launch/launch';
import s from './CommandPalette.module.css';

interface Entry {
  key: string;
  title: string;
  sub?: string;
  kind: string;
  color?: string | null;
  icon?: ReactNode;
  run: () => void;
}

/** Every query word must appear (in any order) in the entry's title or subtitle. */
function matches(e: Entry, words: string[]): boolean {
  const hay = `${e.title} ${e.sub ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Mounted only while open, so every opening starts with an empty query. */
export function CommandPalette() {
  const open = useApp((st) => st.paletteOpen);
  return open ? <Palette /> : null;
}

function Palette() {
  const t = useT();
  const projects = useWorkspace((w) => w.projects);
  const library = useLibrary((l) => l.entries);
  const home = useApp((st) => st.home);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const p of projects) {
      for (const term of p.terminals) {
        out.push({
          key: term.id,
          title: term.name,
          sub: `${p.name} — ${shortPath(term.lastCwd ?? p.path, home)}`,
          kind: t('palette.terminal'),
          color: term.color,
          run: () => selectTerminal(term.id),
        });
      }
    }
    for (const p of projects) {
      out.push({
        key: p.id,
        title: p.name,
        sub: p.path,
        kind: t('palette.project'),
        color: p.color,
        run: () => {
          activateProject(p.id);
          openLibrary(false);
        },
      });
    }
    // Library projects that aren't open: Enter opens them as a tab.
    const open = new Set(projects.map((p) => p.id));
    for (const e of library) {
      if (open.has(e.id) || e.missing || e.status === 'archived') continue;
      out.push({
        key: 'lib:' + e.id,
        title: e.name,
        sub: shortPath(e.path, home),
        kind: t('palette.library'),
        color: e.color,
        run: () => void openFromLibrary(e.id),
      });
    }
    out.push(
      {
        key: 'a:library',
        title: t('library.title'),
        sub: 'Ctrl+Shift+L',
        kind: t('palette.action'),
        icon: <Grid16Regular />,
        run: () => openLibrary(true),
      },
      {
        key: 'a:new',
        title: t('terminals.new'),
        sub: 'Ctrl+Shift+T',
        kind: t('palette.action'),
        icon: <Add16Regular />,
        run: () => newTerminalInActive(),
      },
      ...LAUNCHERS.filter((l) => l.id !== 'shell').map((l) => ({
        key: `a:l:${l.id}`,
        title: t(l.label),
        kind: t('palette.action'),
        icon: <LauncherIcon id={l.id} />,
        run: () => launch(l.id),
      })),
      {
        key: 'a:resume',
        title: t('launch.resume'),
        kind: t('palette.action'),
        icon: <ResumeIcon />,
        run: openSessionPicker,
      },
      {
        key: 'a:split',
        title: t('pane.split'),
        sub: 'Ctrl+Shift+5',
        kind: t('palette.action'),
        icon: <SplitVertical16Regular />,
        run: splitActive,
      },
      {
        key: 'a:project',
        title: t('projects.add'),
        sub: 'Ctrl+Shift+O',
        kind: t('palette.action'),
        icon: <FolderAdd16Regular />,
        run: () => void pickAndAddProject(),
      },
      {
        key: 'a:settings',
        title: t('settings.title'),
        sub: 'Ctrl+,',
        kind: t('palette.action'),
        icon: <Settings16Regular />,
        run: () => useApp.setState({ settingsOpen: true }),
      },
      ...(useApp.getState().update.state === 'unsupported'
        ? []
        : [
            {
              key: 'a:update',
              title: t('update.check'),
              kind: t('palette.action'),
              icon: <ArrowSync16Regular />,
              run: checkForUpdates,
            },
          ]),
    );
    for (const prof of useApp.getState().profiles) {
      out.push({
        key: `a:p:${prof.id}`,
        title: `${t('terminals.new')}: ${prof.name}`,
        kind: t('palette.action'),
        icon: <Add16Regular />,
        run: () => newTerminalInActive({ profileId: prof.id }),
      });
    }
    return out;
  }, [projects, library, t, home]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => matches(e, words)).slice(0, 60);
  const current = Math.min(index, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const close = () => useApp.setState({ paletteOpen: false });
  const run = (e: Entry | undefined) => {
    if (!e) return;
    close();
    e.run();
  };

  return (
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.card} role="dialog" aria-modal="true" aria-label={t('titlebar.search')}>
        <div className={s.inputRow}>
          <Search16Regular />
          <input
            autoFocus
            className={s.input}
            value={query}
            placeholder={t('palette.placeholder')}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') setIndex((i) => Math.min(shown.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else if (e.key === 'Enter') run(shown[current]);
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <div className={s.list} id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className={s.none}>{t('palette.none')}</div>}
          {shown.map((e, i) => (
            <button
              key={e.key}
              type="button"
              role="option"
              aria-selected={i === current}
              data-index={i}
              className={cx(s.item, i === current && s.selected)}
              onPointerMove={() => i !== current && setIndex(i)}
              onClick={() => run(e)}
            >
              {e.icon ? (
                <span className={s.tile}>{e.icon}</span>
              ) : (
                <span className={s.colorBar} style={e.color ? { background: e.color } : undefined} />
              )}
              <span className={s.text}>
                <span className={s.title}>{e.title}</span>
                {e.sub && <span className={s.sub}>{e.sub}</span>}
              </span>
              <span className={s.kind}>{e.kind}</span>
            </button>
          ))}
        </div>
        <div className={s.footer}>{t('palette.hint')}</div>
      </div>
    </div>
  );
}
