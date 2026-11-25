import {
  CheckmarkCircle16Regular,
  Dismiss12Regular,
  ErrorCircle16Regular,
  Info16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { TAG_COLORS } from '@shared/colors';
import { closeMenu, dismissToast, useApp, useT, type Dialog } from '../state/app';
import { Button, cx, IconButton } from './Button';
import s from './ui.module.css';

export function Toasts() {
  const toasts = useApp((st) => st.toasts);
  const t = useT();
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={cx(s.toast, s[`toast${x.kind}`])}>
          {x.kind === 'success' ? (
            <CheckmarkCircle16Regular />
          ) : x.kind === 'error' ? (
            <ErrorCircle16Regular />
          ) : (
            <Info16Regular />
          )}
          <span className={s.toastText}>{x.text}</span>
          <IconButton label={t('common.close')} size="sm" onClick={() => dismissToast(x.id)}>
            <Dismiss12Regular />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** Confirm / prompt dialog (confirmDialog, promptDialog). Remounted per dialog so its state starts fresh. */
export function DialogHost() {
  const dialog = useApp((st) => st.dialog);
  return dialog ? <DialogView key={dialog.title + (dialog.value ?? '')} dialog={dialog} /> : null;
}

function DialogView({ dialog }: { dialog: Dialog }) {
  const t = useT();
  const [value, setValue] = useState(dialog.value ?? '');
  const input = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (dialog.kind === 'prompt') {
        input.current?.focus();
        input.current?.select();
      } else {
        okRef.current?.focus();
      }
    });
  }, [dialog]);

  const finish = (result: string | boolean | null) => {
    useApp.setState({ dialog: null });
    dialog.resolve(result);
  };
  const submit = () => finish(dialog.kind === 'prompt' ? value : true);

  return (
    <div
      className={s.scrim}
      onPointerDown={(e) => e.target === e.currentTarget && finish(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
    >
      <form
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={s.dialogBody}>
          <h2 id="dialog-title" className={s.dialogTitle}>
            {dialog.title}
          </h2>
          {dialog.body && <p className={s.dialogText}>{dialog.body}</p>}
          {dialog.kind === 'prompt' && (
            <input
              ref={input}
              className={s.input}
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>
        <div className={s.dialogFooter}>
          <Button onClick={() => finish(null)}>{t('common.cancel')}</Button>
          <Button
            ref={okRef}
            type="submit"
            variant={dialog.danger ? 'danger' : 'primary'}
            disabled={dialog.kind === 'prompt' && !value.trim()}
          >
            {dialog.ok}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Color choices for project/terminal menus: the 9 tag colors, none and a custom one. */
export function ColorSwatches({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (color: string | null) => void;
}) {
  const t = useT();
  const pick = (c: string | null) => {
    closeMenu();
    onPick(c);
  };
  return (
    <div className={s.swatches}>
      <button
        type="button"
        className={cx(s.swatch, s.swatchNone)}
        title={t('terminals.noColor')}
        aria-label={t('terminals.noColor')}
        onClick={() => pick(null)}
      >
        {value === null && '✓'}
      </button>
      {TAG_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          className={s.swatch}
          style={{ background: c.hex }}
          title={c.key}
          aria-label={c.key}
          onClick={() => pick(c.hex)}
        >
          {value === c.hex && '✓'}
        </button>
      ))}
      <label className={cx(s.swatch, s.swatchCustom)} title={t('terminals.customColor')}>
        <input
          type="color"
          defaultValue={value ?? '#7480FF'}
          onChange={(e) => onPick(e.target.value.toUpperCase())}
          onBlur={closeMenu}
        />
      </label>
    </div>
  );
}
