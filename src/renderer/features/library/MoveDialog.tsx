import {
  Checkmark16Regular,
  ErrorCircle16Regular,
  FolderOpen16Regular,
  HardDrive16Regular,
  Info16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import type { StringKey } from '@shared/i18n';
import { baseName } from '@shared/workspace';
import { isValidFolderName, joinPath, type MovePlan, type MoveWarning } from '@shared/move';
import { Button, cx } from '../../components/Button';
import { api } from '../../lib/api';
import { bytes } from '../../lib/format';
import { useT } from '../../state/app';
import { CLAUDE_LABEL } from '../../components/ClaudeGlyph';
import { moveError, op, useLibrary, useLibraryView, useMoves } from '../../state/library';
import { newId } from '../../state/workspace';
import { moveDestination } from './LibraryView';
import s from './Library.module.css';

const BLOCKER: Record<string, StringKey> = {
  same: 'move.bSame',
  'source-missing': 'move.bMissing',
  'dest-exists': 'move.bExists',
  'dest-inside-source': 'move.bInside',
  'source-protected': 'move.bProtected',
  'unsupported-path': 'move.bUnsupported',
  'invalid-name': 'move.bName',
  'no-space': 'move.bSpace',
  'dest-unreachable': 'move.bUnreachable',
  busy: 'move.bBusy',
};
const WARNING: Record<MoveWarning, StringKey> = {
  'cross-volume': 'move.wCross',
  venv: 'move.wVenv',
  cmake: 'move.wCmake',
  worktrees: 'move.wWorktrees',
  'is-worktree': 'move.wIsWorktree',
};
const PHASE: Record<string, StringKey> = {
  waiting: 'move.pWaiting',
  stopping: 'move.pStopping',
  moving: 'move.pMoving',
  copying: 'move.pCopying',
  verifying: 'move.pVerifying',
  claude: 'move.pClaude',
  git: 'move.pGit',
  restarting: 'move.pRestarting',
  done: 'move.pDone',
  failed: 'move.pFailed',
  cancelled: 'move.pCancelled',
};

/** Mounted only while open (a fresh state each time). */
export function MoveDialog() {
  const id = useLibraryView((v) => v.moving);
  return id ? <Dialog key={id} entryId={id} /> : null;
}

function Dialog({ entryId }: { entryId: string }) {
  const tr = useT();
  const entry = useLibrary((l) => l.entries.find((e) => e.id === entryId) ?? null);
  const folders = useLibrary((l) => l.folders);
  const progress = useMoves((m) => m[entryId]);
  const [folder, setFolder] = useState<string | null>(() => {
    const dropped = moveDestination.get(entryId);
    moveDestination.delete(entryId);
    return dropped ?? folders[0]?.path ?? null;
  });
  const [name, setName] = useState(() => (entry ? baseName(entry.path) : ''));
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [wait, setWait] = useState(true);
  const [started, setStarted] = useState<string | null>(null);
  const [disks, setDisks] = useState(new Map<string, number>());

  const close = () => useLibraryView.setState({ moving: null });
  const destination = folder && name.trim() ? joinPath(folder, name.trim()) : null;

  useEffect(() => {
    void api
      .invoke(
        'library:disk',
        folders.map((f) => f.path),
      )
      .then((list) => setDisks(new Map(list.map((d) => [d.path, d.free]))));
  }, [folders]);

  // The plan follows the destination (debounced while the name is typed).
  useEffect(() => {
    if (!destination || started) return;
    let live = true;
    const timer = setTimeout(() => {
      void api.invoke('move:plan', entryId, destination).then(
        (p) => live && setPlan(p),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [destination, entryId, started]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const claudeBusy = useMemo(
    () => plan?.terminals.some((x) => x.claude === 'busy' || x.claude === 'waiting') ?? false,
    [plan],
  );
  const running = useMemo(() => plan?.terminals.filter((x) => x.busy) ?? [], [plan]);

  if (!entry) return null;
  const mine = progress && progress.id === started ? progress : null;
  const finished = mine && ['done', 'failed', 'cancelled'].includes(mine.phase);

  const pickOther = async () => {
    const p = await api.invoke('dialog:pick-folder', tr('move.pickTitle'));
    if (p) setFolder(p);
  };
  const start = async () => {
    if (!plan || plan.blockers.length > 0) return;
    // A folder picked with "Other folder…" can become a library folder in one go: the parent is remembered.
    const ok = await api.invoke('move:start', plan.id, claudeBusy && wait);
    if (ok) setStarted(plan.id);
    else setPlan(await api.invoke('move:plan', entryId, plan.destination));
  };
  const nameOk = isValidFolderName(name.trim());
  // The plan on screen is for another destination (being typed): it is being checked again.
  const planning = !!destination && plan?.destination !== destination;
  const isLibraryFolder =
    folder !== null && folders.some((f) => f.path.toLowerCase() === folder.toLowerCase());

  return (
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="move-title">
        <div className={s.dialogHead}>
          <h2 id="move-title" className={s.dialogTitle}>
            {tr('move.title', entry.name)}
          </h2>
        </div>
        <div className={s.dialogBody}>
          <div className={s.field}>
            <span className={s.fieldLabel}>{tr('move.from')}</span>
            <span className={s.pathLine}>{entry.path}</span>
          </div>

          {mine ? (
            <Progress
              plan={plan}
              phase={mine.phase}
              bytesDone={mine.bytes}
              total={mine.totalBytes}
              error={mine.error}
            />
          ) : (
            <>
              <div className={s.field}>
                <span className={s.fieldLabel}>{tr('move.to')}</span>
                <div className={s.choices} role="radiogroup">
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="radio"
                      aria-checked={folder === f.path}
                      className={cx(s.choice, folder === f.path && s.choiceOn)}
                      onClick={() => setFolder(f.path)}
                    >
                      <span className={s.radio} />
                      <span className={s.folderPath} title={f.path}>
                        <bdi>{f.path}</bdi>
                      </span>
                      <span className={s.choiceSub}>
                        {disks.has(f.path) ? tr('library.free', bytes(disks.get(f.path)!)) : ''}
                      </span>
                    </button>
                  ))}
                  {folder && !isLibraryFolder && (
                    <button
                      type="button"
                      role="radio"
                      aria-checked="true"
                      className={cx(s.choice, s.choiceOn)}
                    >
                      <span className={s.radio} />
                      <span className={s.folderPath} title={folder}>
                        <bdi>{folder}</bdi>
                      </span>
                      <span
                        className={s.choiceSub}
                        role="link"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          void op({ op: 'folderAdd', id: newId('f'), path: folder });
                        }}
                      >
                        {tr('move.keepFolder')}
                      </span>
                    </button>
                  )}
                  <button type="button" className={s.choice} onClick={() => void pickOther()}>
                    <FolderOpen16Regular />
                    <span>{tr('move.other')}</span>
                    <span />
                  </button>
                </div>
                {folders.length === 0 && <span className={s.muted}>{tr('move.noFoldersHint')}</span>}
              </div>
              <div className={s.field}>
                <span className={s.fieldLabel}>{tr('move.name')}</span>
                <input
                  className={s.input}
                  value={name}
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                />
                {destination && <span className={s.pathLine}>{destination}</span>}
              </div>
              {plan && plan.destination === destination && (
                <PlanDetails
                  plan={plan}
                  running={running}
                  claudeBusy={claudeBusy}
                  wait={wait}
                  setWait={setWait}
                  nameOk={nameOk}
                />
              )}
            </>
          )}
        </div>
        <div className={s.dialogFoot}>
          <span className={s.footNote}>
            {!mine && planning ? tr('move.checking') : mine && !finished ? tr('move.runningNote') : ''}
          </span>
          {mine && !finished ? (
            <>
              {['waiting', 'stopping', 'copying', 'moving'].includes(mine.phase) && (
                <Button onClick={() => void api.invoke('move:cancel', mine.id)}>{tr('move.cancel')}</Button>
              )}
              <Button onClick={close}>{tr('move.background')}</Button>
            </>
          ) : finished ? (
            <Button variant="primary" onClick={close}>
              {tr('common.close')}
            </Button>
          ) : (
            <>
              <Button onClick={close}>{tr('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={!plan || plan.destination !== destination || plan.blockers.length > 0 || planning}
                onClick={() => void start()}
              >
                {tr('move.start')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanDetails({
  plan,
  running,
  claudeBusy,
  wait,
  setWait,
  nameOk,
}: {
  plan: MovePlan;
  running: MovePlan['terminals'];
  claudeBusy: boolean;
  wait: boolean;
  setWait: (v: boolean) => void;
  nameOk: boolean;
}) {
  const tr = useT();
  const blockers = nameOk ? plan.blockers : [...new Set([...plan.blockers, 'invalid-name' as const])];
  return (
    <>
      {blockers.map((b) => (
        <div key={b} className={cx(s.notice, s.noticeDanger)}>
          <ErrorCircle16Regular />
          <span>{tr(BLOCKER[b] ?? 'move.bUnsupported')}</span>
        </div>
      ))}
      {blockers.length === 0 && plan.terminals.length > 0 && (
        <div className={cx(s.notice, s.noticeWarn)}>
          <Warning16Regular />
          <span>
            {tr('move.terminals', plan.terminals.length)}
            <ul className={s.termList}>
              {plan.terminals.map((x) => (
                <li key={x.id}>
                  <strong>{x.name}</strong>
                  <span className={s.termWhat}>
                    {x.claude
                      ? tr('move.termClaude', tr(CLAUDE_LABEL[x.claude]))
                      : x.busy
                        ? tr('move.termRunning', x.foreground ?? '…')
                        : tr('move.termIdle')}
                    {x.projectId !== plan.entryId ? ' · ' + x.projectName : ''}
                  </span>
                </li>
              ))}
            </ul>
          </span>
        </div>
      )}
      {blockers.length === 0 && claudeBusy && (
        <label className={s.check}>
          <input type="checkbox" checked={wait} onChange={(e) => setWait(e.target.checked)} />
          {tr('move.waitClaude')}
        </label>
      )}
      {blockers.length === 0 && running.length > 0 && (
        <span className={s.muted}>{tr('move.runningHint')}</span>
      )}
      {blockers.length === 0 &&
        plan.warnings.map((w) => (
          <div key={w} className={s.notice}>
            {w === 'cross-volume' ? <HardDrive16Regular /> : <Info16Regular />}
            <span>
              {w === 'cross-volume'
                ? tr('move.wCross', plan.bytes === null ? '?' : bytes(plan.bytes))
                : tr(WARNING[w])}
            </span>
          </div>
        ))}
      {blockers.length === 0 && (plan.claudeDirs > 0 || plan.nested.length > 0) && (
        <div className={s.notice}>
          <Checkmark16Regular />
          <span>
            {[
              plan.claudeDirs > 0 ? tr('move.claudeData') : null,
              plan.nested.length > 0 ? tr('move.nested', plan.nested.map((n) => n.name).join(', ')) : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        </div>
      )}
    </>
  );
}

function Progress({
  plan,
  phase,
  bytesDone,
  total,
  error,
}: {
  plan: MovePlan | null;
  phase: string;
  bytesDone?: number;
  total?: number;
  error?: string;
}) {
  const tr = useT();
  const fraction = phase === 'copying' && total ? (bytesDone ?? 0) / total : phase === 'done' ? 1 : null;
  return (
    <div className={s.field}>
      <span className={s.phase}>
        <span>{tr(PHASE[phase] ?? 'move.pMoving')}</span>
        {phase === 'copying' && total ? <span>{`${bytes(bytesDone ?? 0)} / ${bytes(total)}`}</span> : null}
      </span>
      <span className={cx(s.progress)}>
        <span
          style={{
            width: `${Math.round((fraction ?? (phase === 'failed' || phase === 'cancelled' ? 0 : 0.5)) * 100)}%`,
          }}
        />
      </span>
      {phase === 'failed' && (
        <div className={cx(s.notice, s.noticeDanger)}>
          <ErrorCircle16Regular />
          <span>{moveError(error)}</span>
        </div>
      )}
      {phase === 'done' && plan && <span className={s.pathLine}>{plan.destination}</span>}
    </div>
  );
}
