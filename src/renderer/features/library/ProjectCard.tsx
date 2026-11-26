import {
  Apps16Regular,
  Book16Regular,
  Branch16Regular,
  Code16Regular,
  DataBarVertical16Regular,
  Folder16Regular,
  Games16Regular,
  Globe16Regular,
  Library16Regular,
  Server16Regular,
  Sparkle16Regular,
  Star16Filled,
  Star16Regular,
  Wrench16Regular,
} from '@fluentui/react-icons';
import { memo, useState, type ReactNode } from 'react';
import type { StringKey } from '@shared/i18n';
import { entryDescription, entryStack, type LibraryEntry, type ProjectKind } from '@shared/library';
import { languageColor } from '@shared/stack';
import { cx, IconButton } from '../../components/Button';
import { ClaudeGlyph } from '../../components/ClaudeGlyph';
import { shortPath } from '../../lib/format';
import { useApp, useT } from '../../state/app';
import { setFavorite, useMoves } from '../../state/library';
import { useRuntime } from '../../state/runtime';
import { useWorkspace } from '../../state/workspace';
import { projectClaudeState } from '@shared/claude';
import s from './Library.module.css';

export const LIBRARY_DRAG = 'application/x-atelier-library';

const KIND_ICON: Record<ProjectKind, ReactNode> = {
  app: <Apps16Regular />,
  web: <Globe16Regular />,
  api: <Server16Regular />,
  service: <Server16Regular />,
  library: <Library16Regular />,
  game: <Games16Regular />,
  tool: <Wrench16Regular />,
  docs: <Book16Regular />,
  data: <DataBarVertical16Regular />,
  scripts: <Code16Regular />,
  other: <Code16Regular />,
};

type T = (key: StringKey, ...args: (string | number)[]) => string;

/** "just now", "5 min ago", "3 d ago", "4 months ago", "2 years ago". */
export function ago(ms: number | null, t: T, now = Date.now()): string {
  if (!ms) return '';
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return t('time.now');
  if (min < 60) return t('time.minutes', min);
  const h = Math.floor(min / 60);
  if (h < 24) return t('time.hours', h);
  const d = Math.floor(h / 24);
  if (d < 45) return t('time.days', d);
  if (d < 365) return t('time.months', Math.round(d / 30));
  const years = Math.floor(d / 365);
  return years === 1 ? t('time.year') : t('time.years', years);
}

export function kindOf(e: LibraryEntry): ProjectKind | null {
  return e.claude?.kind ?? e.local?.kind ?? null;
}

export function KindIcon({ e }: { e: LibraryEntry }) {
  const kind = kindOf(e);
  return <span className={s.kind}>{kind ? KIND_ICON[kind] : <Folder16Regular />}</span>;
}

/** Last activity: the newest of the last commit and the folder's own changes. */
export function lastActivity(e: LibraryEntry): number | null {
  const m = Math.max(e.local?.git?.lastCommitAt ?? 0, e.local?.modifiedAt ?? 0);
  return m || null;
}

function Languages({ e }: { e: LibraryEntry }) {
  const langs = e.local?.languages ?? [];
  const total = langs.reduce((a, l) => a + l.files, 0);
  if (total === 0) return <span className={s.langs} aria-hidden="true" />;
  return (
    <span
      className={s.langs}
      title={langs.map((l) => `${l.name} ${Math.round((l.files / total) * 100)}%`).join('\n')}
    >
      {langs.map((l) => (
        <span
          key={l.name}
          style={{ width: `${(l.files / total) * 100}%`, background: languageColor(l.name) }}
        />
      ))}
    </span>
  );
}

/** Open (with Claude's state when a session runs), missing, moving… */
function Badges({ e }: { e: LibraryEntry }) {
  const t = useT();
  const project = useWorkspace((w) => w.projects.find((p) => p.id === e.id) ?? null);
  const claude = useRuntime((st) =>
    project ? projectClaudeState(project.terminals.map((x) => st.claude[x.id]?.state)) : null,
  );
  if (e.missing) return <span className={cx(s.badge, s.badgeWarn)}>{t('library.badgeMissing')}</span>;
  if (!project) return null;
  return (
    <span className={cx(s.badge, s.badgeOpen)} title={t('library.badgeOpenTip')}>
      {claude && <ClaudeGlyph state={claude} />}
      {t('library.badgeOpen')}
    </span>
  );
}

function MoveStrip({ id }: { id: string }) {
  const p = useMoves((m) => m[id]);
  if (!p || ['done', 'failed', 'cancelled'].includes(p.phase)) return null;
  const fraction = p.phase === 'copying' && p.totalBytes ? (p.bytes ?? 0) / p.totalBytes : null;
  return (
    <span className={cx(s.moveBar, fraction === null && s.moveIndeterminate)} aria-hidden="true">
      <span style={{ width: `${(fraction ?? 1) * 100}%` }} />
    </span>
  );
}

function Description({ e, t }: { e: LibraryEntry; t: T }) {
  const text = entryDescription(e);
  const running = e.job.state === 'queued' || e.job.state === 'running';
  if (text)
    return (
      <p className={s.desc} title={text}>
        {text}
      </p>
    );
  if (running)
    return (
      <span className={s.describing}>
        <Sparkle16Regular fontSize={14} />
        {t(e.job.state === 'running' ? 'library.describing' : 'library.describeQueued')}
      </span>
    );
  return (
    <p className={cx(s.desc, s.descPending)}>
      {e.local && !e.local.isCode ? t('library.notCode') : t('library.noDescription')}
    </p>
  );
}

export interface CardProps {
  e: LibraryEntry;
  selected: boolean;
  layout: 'grid' | 'list';
  onSelect: (id: string, ev: React.MouseEvent | React.KeyboardEvent) => void;
  onOpen: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onKey: (id: string, ev: React.KeyboardEvent) => void;
  onFilterStack: (item: string) => void;
}

export const ProjectCard = memo(function ProjectCard({
  e,
  selected,
  layout,
  onSelect,
  onOpen,
  onMenu,
  onKey,
  onFilterStack,
}: CardProps) {
  const t = useT();
  const home = useApp((st) => st.home);
  const [dragging, setDragging] = useState(false);
  const stack = entryStack(e);
  const shown = layout === 'grid' ? stack.slice(0, 5) : stack.slice(0, 3);
  const when = lastActivity(e);
  const describing = e.job.state === 'running' && !!entryDescription(e);

  const common = {
    role: 'option' as const,
    'aria-selected': selected,
    tabIndex: 0,
    'data-entry': e.id,
    draggable: true,
    onDragStart: (ev: React.DragEvent) => {
      ev.dataTransfer.setData(LIBRARY_DRAG, e.id);
      ev.dataTransfer.effectAllowed = 'copyMove';
      setDragging(true);
    },
    onDragEnd: () => setDragging(false),
    onClick: (ev: React.MouseEvent) => onSelect(e.id, ev),
    onDoubleClick: () => onOpen(e.id),
    onKeyDown: (ev: React.KeyboardEvent) => onKey(e.id, ev),
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      if (!selected) onSelect(e.id, ev);
      onMenu(e.id, ev.clientX, ev.clientY);
    },
  };

  const star = (
    <IconButton
      label={e.favorite ? t('library.unfavorite') : t('library.favorite')}
      size="sm"
      className={cx(s.star, e.favorite && s.starOn)}
      onClick={(ev) => {
        ev.stopPropagation();
        setFavorite([e.id], !e.favorite);
      }}
      onDoubleClick={(ev) => ev.stopPropagation()}
    >
      {e.favorite ? <Star16Filled /> : <Star16Regular />}
    </IconButton>
  );

  const chips = (
    <span className={s.chips}>
      {shown.map((x) => (
        <button
          key={x}
          type="button"
          className={s.chip}
          title={t('library.filterBy', x)}
          onClick={(ev) => {
            ev.stopPropagation();
            onFilterStack(x);
          }}
          onDoubleClick={(ev) => ev.stopPropagation()}
        >
          {x}
        </button>
      ))}
      {stack.length > shown.length && <span className={s.chip}>+{stack.length - shown.length}</span>}
      {layout === 'grid' &&
        e.tags.map((x) => (
          <span key={'#' + x} className={cx(s.chip, s.tag)}>
            {x}
          </span>
        ))}
    </span>
  );

  if (layout === 'list')
    return (
      <div
        {...common}
        className={cx(s.row, selected && s.selected, dragging && s.cardDragging, e.missing && s.missing)}
      >
        <KindIcon e={e} />
        <span className={s.rowName}>
          <span className={s.cardName} title={e.path}>
            {e.name}
          </span>
          {star}
          <Badges e={e} />
        </span>
        <Description e={e} t={t} />
        {chips}
        <span className={s.rowWhen}>{ago(when, t)}</span>
        <MoveStrip id={e.id} />
      </div>
    );

  return (
    <div
      {...common}
      className={cx(s.card, selected && s.selected, dragging && s.cardDragging, e.missing && s.missing)}
    >
      <span className={s.cardTop}>
        <KindIcon e={e} />
        <span className={s.cardName} title={e.path}>
          {e.name}
        </span>
        {star}
        <Badges e={e} />
      </span>
      <Description e={e} t={t} />
      {describing && (
        <span className={s.describing}>
          <Sparkle16Regular fontSize={14} />
          {t('library.describing')}
        </span>
      )}
      {chips}
      <span className={s.meta}>
        {e.local?.git?.branch && (
          <span className={s.metaItem} title={e.local.git.worktree ? t('library.worktree') : undefined}>
            <Branch16Regular fontSize={12} />
            {e.local.git.branch}
          </span>
        )}
        {when && (
          <span className={s.metaItem} title={new Date(when).toLocaleString()}>
            {ago(when, t)}
          </span>
        )}
        <span className={s.metaPath} title={e.path}>
          <bdi>{shortPath(e.path, home)}</bdi>
        </span>
      </span>
      <Languages e={e} />
      <MoveStrip id={e.id} />
    </div>
  );
});
