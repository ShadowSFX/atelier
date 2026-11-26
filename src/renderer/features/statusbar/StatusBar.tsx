import { Sparkle12Filled } from '@fluentui/react-icons';
import { cx } from '../../components/Button';
import { api } from '../../lib/api';
import { bytes, levelOf, percent } from '../../lib/format';
import { useApp, useT } from '../../state/app';
import { closeApp } from '../../state/quit';
import { useRuntime } from '../../state/runtime';
import { activeProject, focusedTerminalId, useWorkspace } from '../../state/workspace';
import s from './StatusBar.module.css';
import { WeeklyUsage } from './WeeklyUsage';

const level = (f: number) => ({ danger: s.danger, warn: s.warn, ok: s.value })[levelOf(f)];

function Sparkline({ values }: { values: number[] }) {
  const w = 48;
  const h = 12;
  if (values.length < 2) return <svg className={s.spark} width={w} height={h} aria-hidden="true" />;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - v * (h - 2)).toFixed(1)}`).join(' ');
  return (
    <svg className={s.spark} width={w} height={h} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusBar() {
  const t = useT();
  const stats = useRuntime((st) => st.stats);
  const history = useRuntime((st) => st.cpuHistory);
  const focused = useWorkspace((w) => focusedTerminalId(w));
  const project = useWorkspace((w) => activeProject(w));
  const term = useRuntime((st) => (focused ? st.byTerminal[focused] : undefined));
  const claudeCount = useRuntime((st) =>
    project ? project.terminals.filter((x) => st.claude[x.id]?.state).length : 0,
  );
  const update = useApp((st) => st.update);
  const focusedName = project?.terminals.find((x) => x.id === focused)?.name;

  return (
    <footer className={s.bar}>
      <div className={s.left}>
        {stats && (
          <>
            <span className={s.item} title={t('status.cpuTip')}>
              <span className={s.label}>{t('status.cpu')}</span>
              <Sparkline values={history} />
              <span className={level(stats.cpu)}>{percent(stats.cpu)}</span>
            </span>
            <span className={s.item} title={t('status.ramTip', bytes(stats.memUsed), bytes(stats.memTotal))}>
              <span className={s.label}>{t('status.ram')}</span>
              <span className={level(stats.memUsed / stats.memTotal)}>
                {bytes(stats.memUsed)} / {bytes(stats.memTotal)}
              </span>
            </span>
            {stats.disk && stats.disk.total > 0 && (
              <span
                className={s.item}
                title={t('status.diskTip', bytes(stats.disk.used), bytes(stats.disk.total))}
              >
                <span className={s.label}>{t('status.disk')}</span>
                <span className={level(stats.disk.used / stats.disk.total)}>
                  {percent(stats.disk.used / stats.disk.total)}
                </span>
              </span>
            )}
            <span className={s.item} title={t('status.appTip')}>
              <span className={s.label}>{t('status.app')}</span>
              <span className={s.value}>{bytes(stats.appMemory)}</span>
            </span>
          </>
        )}
      </div>
      <WeeklyUsage />
      <div className={s.right}>
        {claudeCount > 0 && (
          <span className={cx(s.item, s.claude)}>
            <Sparkle12Filled />
            {t('claude.sessions', claudeCount)}
          </span>
        )}
        {term && focusedName && (
          <span className={s.item} title={t('status.termTip')}>
            <span className={s.label}>{term.foreground ?? focusedName}</span>
            <span className={s.value}>{percent(term.cpu)}</span>
            <span className={s.value}>{bytes(term.memory)}</span>
          </span>
        )}
        {(update.state === 'downloading' || update.state === 'available') && (
          <span className={s.update} title={t('status.updateTip')}>
            {update.progress === undefined
              ? t('update.downloading', update.version ?? '')
              : t('status.downloading', update.version ?? '', Math.floor(update.progress * 100))}
          </span>
        )}
        {update.state === 'checking' && <span className={s.item}>{t('update.checking')}</span>}
        {update.state === 'downloaded' && (
          <span className={s.update} title={t('status.updateTip')}>
            {t('status.update', update.version ?? '')}
            <button type="button" className={s.updateBtn} onClick={() => void closeApp(true)}>
              {t('status.restart')}
            </button>
          </span>
        )}
        {update.state === 'manual' && update.url && (
          <span className={s.update} title={t('status.updateManualTip')}>
            {t('status.updateAvailable', update.version ?? '')}
            <button
              type="button"
              className={s.updateBtn}
              onClick={() => void api.invoke('shell:open-external', update.url!)}
            >
              {t('status.download')}
            </button>
          </span>
        )}
      </div>
    </footer>
  );
}
