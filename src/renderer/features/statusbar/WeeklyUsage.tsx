import { useEffect, useState } from 'react';
import { displayPercent, pastMoment, resetLabel, resetLong } from '@shared/usage';
import { cx } from '../../components/Button';
import { levelOf } from '../../lib/format';
import { useApp, useT } from '../../state/app';
import { useRuntime } from '../../state/runtime';
import s from './StatusBar.module.css';

const FILL = { ok: undefined, warn: s.fillWarn, danger: s.fillDanger };
const TEXT = { ok: undefined, warn: s.warn, danger: s.danger };

/** Re-renders every `ms` (the reset label and the tooltip's times move with the clock). */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The Claude plan's weekly usage, centered in the status bar: label, meter, percentage and when it resets. The
 * 5-hour window is in the tooltip. Nothing is shown without a report (API key, no reply yet) or when turned off.
 */
export function WeeklyUsage() {
  const t = useT();
  const enabled = useApp((st) => st.settings.showClaudeUsage);
  const lang = useApp((st) => st.lang);
  const systemLocale = useApp((st) => st.locale);
  const usage = useRuntime((st) => st.usage);
  const now = useNow(60_000);

  const week = usage?.sevenDay;
  // Main drops a window when it resets; this also covers the minute before its timer fires.
  if (!enabled || !usage || !week || week.resetsAt <= now) return <span />;

  // Dates in the user's regional format when it matches the app's language (es-CL, en-GB…).
  const locale = systemLocale.toLowerCase().startsWith(lang) ? systemLocale : lang;
  const pct = displayPercent(week.usedPercentage);
  const lvl = levelOf(week.usedPercentage / 100);
  const five = usage.fiveHour && usage.fiveHour.resetsAt > now ? usage.fiveHour : null;
  const tip = [
    t('usage.tipWeekly', pct, resetLong(week.resetsAt, locale)),
    five ? t('usage.tipFiveHour', displayPercent(five.usedPercentage), resetLong(five.resetsAt, locale)) : '',
    t('usage.tipUpdated', pastMoment(usage.at, now, locale)),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span
      className={s.usage}
      title={tip}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={t('usage.aria', pct)}
      data-level={lvl}
    >
      <span className={s.label}>{t('usage.weekly')}</span>
      <span className={s.meter} aria-hidden="true">
        <span className={cx(s.meterFill, FILL[lvl])} style={{ width: `${pct}%` }} />
      </span>
      <span className={cx(s.usagePct, TEXT[lvl])}>{pct}%</span>
      <span className={s.usageReset}>{t('usage.resets', resetLabel(week.resetsAt, now, locale))}</span>
    </span>
  );
}
