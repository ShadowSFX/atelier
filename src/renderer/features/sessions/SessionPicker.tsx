import { Branch16Regular, FolderOpen16Regular, History16Regular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeSessionInfo } from '@shared/launchers';
import type { StringKey } from '@shared/i18n';
import { cx } from '../../components/Button';
import { api } from '../../lib/api';
import { useApp, useT } from '../../state/app';
import {
  activeProject,
  newTerminalInActive,
  selectTerminal,
  terminalWithSession,
  useWorkspace,
} from '../../state/workspace';
import s from './SessionPicker.module.css';

/** The sessions of `path` (a list for another project, from before the active one changed, counts as loading). */
type Load = { path: string } & ({ state: 'error' } | { state: 'ready'; sessions: ClaudeSessionInfo[] });

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
function ago(ms: number, t: (key: StringKey, ...args: (string | number)[]) => string): string {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return t('time.now');
  if (min < 60) return t('time.minutes', min);
  const h = Math.floor(min / 60);
  if (h < 24) return t('time.hours', h);
  return t('time.days', Math.floor(h / 24));
}

/** Where a session ran, relative to the project ('' for the project's own folder). */
function subfolder(cwd: string, root: string): string {
  const rest = cwd.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
  return rest;
}

/** Mounted only while open, so every opening reads the sessions again and starts with an empty query. */
export function SessionPicker() {
  const open = useApp((st) => st.sessionsOpen);
  return open ? <Picker /> : null;
}

function Picker() {
  const t = useT();
  const project = useWorkspace((w) => activeProject(w));
  const projects = useWorkspace((w) => w.projects);
  const [loaded, setLoaded] = useState<Load | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [codeMode, setCodeMode] = useState<boolean | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const path = project?.path ?? '';

  useEffect(() => {
    let live = true;
    if (!path) return;
    api.invoke('claude:sessions', path).then(
      (sessions) => live && setLoaded({ path, state: 'ready', sessions }),
      () => live && setLoaded({ path, state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [path]);

  // What the workspace knows about each session: the terminal running it, and whether it ran in Code Mode.
  const known = useMemo(() => {
    const m = new Map<string, { codeMode: boolean }>();
    for (const p of projects)
      for (const term of p.terminals)
        if (term.claude?.sessionId) m.set(term.claude.sessionId, { codeMode: term.claude.codeMode });
    return m;
  }, [projects]);

  const load = loaded?.path === path ? loaded : ({ state: 'loading' } as const);
  const sessions = load.state === 'ready' ? load.sessions : [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sessions.filter((x) => {
    const hay = `${x.title} ${x.gitBranch ?? ''} ${subfolder(x.cwd, path)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const current = Math.min(index, Math.max(0, shown.length - 1));
  const selected = shown[current];
  // The toggle follows the selected session until the user sets it.
  const codeModeOn = codeMode ?? (selected ? (known.get(selected.id)?.codeMode ?? false) : false);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const close = () => useApp.setState({ sessionsOpen: false });
  const resume = (x: ClaudeSessionInfo | undefined) => {
    if (!x) return;
    close();
    // Never the same session in two terminals: both would write one transcript.
    const open = terminalWithSession(x.id);
    if (open) return selectTerminal(open.id);
    newTerminalInActive({ cwd: x.cwd, resume: { sessionId: x.id, codeMode: codeModeOn } });
  };

  if (!project) return null;
  return (
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.card} role="dialog" aria-modal="true" aria-label={t('sessions.title')}>
        <div className={s.inputRow}>
          <History16Regular />
          <input
            autoFocus
            className={s.input}
            value={query}
            placeholder={t('sessions.search')}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="session-list"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') setIndex((i) => Math.min(shown.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else if (e.key === 'Enter') resume(selected);
              else return;
              e.preventDefault();
            }}
          />
          <span className={s.project}>{project.name}</span>
        </div>
        <div
          className={s.list}
          id="session-list"
          role="listbox"
          ref={list}
          aria-busy={load.state === 'loading'}
        >
          {load.state === 'loading' && <div className={s.note}>{t('sessions.loading')}</div>}
          {load.state === 'error' && <div className={cx(s.note, s.error)}>{t('sessions.error')}</div>}
          {load.state === 'ready' && sessions.length === 0 && (
            <div className={s.note}>{t('sessions.empty')}</div>
          )}
          {load.state === 'ready' && sessions.length > 0 && shown.length === 0 && (
            <div className={s.note}>{t('sessions.none')}</div>
          )}
          {shown.map((x, i) => {
            const openIn = terminalWithSession(x.id);
            const folder = subfolder(x.cwd, path);
            return (
              <button
                key={x.id}
                type="button"
                role="option"
                aria-selected={i === current}
                data-index={i}
                data-session={x.id}
                className={cx(s.item, i === current && s.selected)}
                onPointerMove={() => i !== current && setIndex(i)}
                onClick={() => resume(x)}
              >
                <span className={s.text}>
                  <span className={s.title}>{x.title}</span>
                  <span className={s.meta}>
                    <span className={s.time}>{ago(x.updatedAt, t)}</span>
                    {x.gitBranch && (
                      <span className={s.metaItem}>
                        <Branch16Regular fontSize={12} />
                        {x.gitBranch}
                      </span>
                    )}
                    {folder && (
                      <span className={s.metaItem} title={x.cwd}>
                        <FolderOpen16Regular fontSize={12} />
                        {folder}
                      </span>
                    )}
                  </span>
                </span>
                {openIn && <span className={s.open}>{t('sessions.openIn', openIn.name)}</span>}
              </button>
            );
          })}
        </div>
        <div className={s.footer}>
          <label className={s.toggle}>
            <button
              type="button"
              role="switch"
              aria-checked={codeModeOn}
              className={cx(s.switch, codeModeOn && s.switchOn)}
              onClick={() => setCodeMode(!codeModeOn)}
            />
            {t('sessions.codeMode')}
          </label>
          <span className={s.hint}>{t('sessions.hint')}</span>
        </div>
      </div>
    </div>
  );
}
