import { Dismiss16Regular } from '@fluentui/react-icons';
import { useEffect, type ReactNode } from 'react';
import { SCHEMES } from '@shared/schemes';
import type { Settings } from '@shared/settings';
import { Button, cx, IconButton } from '../../components/Button';
import { saveSettings, useApp, useT } from '../../state/app';
import s from './Settings.module.css';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={s.row}>
      <span className={s.label}>
        <span>{label}</span>
        {hint && <span className={s.hint}>{hint}</span>}
      </span>
      <span className={s.control}>{children}</span>
    </div>
  );
}

function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} className={cx(s.switch, value && s.switchOn)} onClick={() => onChange(!value)} />;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className={s.segmented} role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={cx(s.segment, v === value && s.segmentOn)} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}

function NumberInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      className={s.number}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
      }}
    />
  );
}

export function SettingsDialog() {
  const t = useT();
  const open = useApp((st) => st.settingsOpen);
  const st = useApp((x) => x.settings);
  const profiles = useApp((x) => x.profiles);
  const version = useApp((x) => x.version);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => void saveSettings({ [key]: value });
  const close = () => useApp.setState({ settingsOpen: false });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.window} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className={s.head}>
          <h2 id="settings-title" className={s.title}>
            {t('settings.title')}
          </h2>
          <IconButton label={t('common.close')} onClick={close}>
            <Dismiss16Regular />
          </IconButton>
        </div>
        <div className={s.body}>
          <div className={s.section}>{t('settings.appearance')}</div>
          <Row label={t('settings.theme')}>
            <Segmented
              value={st.theme}
              options={[['system', t('settings.system')], ['dark', t('settings.dark')], ['light', t('settings.light')]]}
              onChange={(v) => set('theme', v)}
            />
          </Row>
          <Row label={t('settings.language')}>
            <Segmented value={st.language} options={[['system', t('settings.system')], ['es', 'Español'], ['en', 'English']]} onChange={(v) => set('language', v)} />
          </Row>
          <Row label={t('settings.scheme')}>
            <select className={s.select} value={st.colorScheme} onChange={(e) => set('colorScheme', e.target.value)}>
              <option value="auto">{t('settings.schemeAuto')}</option>
              {SCHEMES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.tint')}>
            <Switch label={t('settings.tint')} value={st.tintWithColor} onChange={(v) => set('tintWithColor', v)} />
          </Row>

          <div className={s.section}>{t('settings.terminal')}</div>
          <Row label={t('settings.defaultProfile')}>
            <select className={s.select} value={st.defaultProfile} onChange={(e) => set('defaultProfile', e.target.value)}>
              <option value="">{t('settings.system')}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.font')}>
            <select className={s.select} value={st.fontFamily} onChange={(e) => set('fontFamily', e.target.value)}>
              {['Cascadia Code NF', 'Cascadia Mono', 'Consolas', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono'].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.fontSize')}>
            <NumberInput value={st.fontSize} min={8} max={32} onChange={(v) => set('fontSize', v)} />
          </Row>
          <Row label={t('settings.lineHeight')}>
            <NumberInput value={st.lineHeight} min={1} max={2} step={0.05} onChange={(v) => set('lineHeight', v)} />
          </Row>
          <Row label={t('settings.renderer')}>
            <Segmented value={st.renderer} options={[['gpu', t('settings.rendererGpu')], ['subpixel', t('settings.rendererSubpixel')]]} onChange={(v) => set('renderer', v)} />
          </Row>
          <Row label={t('settings.cursor')}>
            <Segmented
              value={st.cursor}
              options={[['bar', t('settings.cursorBar')], ['block', t('settings.cursorBlock')], ['underline', t('settings.cursorUnderline')]]}
              onChange={(v) => set('cursor', v)}
            />
          </Row>
          <Row label={t('settings.cursorBlink')}>
            <Switch label={t('settings.cursorBlink')} value={st.cursorBlink} onChange={(v) => set('cursorBlink', v)} />
          </Row>
          <Row label={t('settings.scrollback')}>
            <NumberInput value={st.scrollback} min={0} max={200000} step={1000} onChange={(v) => set('scrollback', v)} />
          </Row>
          <Row label={t('settings.powerline')} hint={t('settings.powerlineHint')}>
            <Switch label={t('settings.powerline')} value={st.powerlinePrompt} onChange={(v) => set('powerlinePrompt', v)} />
          </Row>

          <div className={s.section}>{t('settings.behavior')}</div>
          <Row label={t('settings.smartCtrlC')}>
            <Switch label={t('settings.smartCtrlC')} value={st.smartCtrlC} onChange={(v) => set('smartCtrlC', v)} />
          </Row>
          <Row label={t('settings.copyOnSelect')}>
            <Switch label={t('settings.copyOnSelect')} value={st.copyOnSelect} onChange={(v) => set('copyOnSelect', v)} />
          </Row>
          <Row label={t('settings.rightClick')}>
            <Segmented value={st.rightClick} options={[['menu', t('settings.rightClickMenu')], ['copypaste', t('settings.rightClickCopyPaste')]]} onChange={(v) => set('rightClick', v)} />
          </Row>
          <Row label={t('settings.warnPaste')}>
            <Switch label={t('settings.warnPaste')} value={st.warnMultilinePaste} onChange={(v) => set('warnMultilinePaste', v)} />
          </Row>
          <Row label={t('settings.bell')}>
            <Segmented value={st.bell} options={[['visual', t('settings.bellVisual')], ['sound', t('settings.bellSound')], ['off', t('settings.bellOff')]]} onChange={(v) => set('bell', v)} />
          </Row>
          <Row label={t('settings.confirmClose')}>
            <Switch label={t('settings.confirmClose')} value={st.confirmCloseRunning} onChange={(v) => set('confirmCloseRunning', v)} />
          </Row>

          <div className={s.section}>{t('settings.claude')}</div>
          <Row label={t('settings.claudeHub')} hint={t('settings.claudeHubHint')}>
            <Switch label={t('settings.claudeHub')} value={st.claudeHub} onChange={(v) => set('claudeHub', v)} />
          </Row>
        </div>
        <div className={s.foot}>
          <span>Atelier {version}</span>
          <Button variant="primary" onClick={close}>
            {t('settings.done')}
          </Button>
        </div>
      </div>
    </div>
  );
}
