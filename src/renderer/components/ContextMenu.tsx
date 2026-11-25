import { Checkmark12Regular } from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeMenu, useApp, type MenuItem } from '../state/app';
import { cx } from './Button';
import s from './ui.module.css';

/** The app's single context menu (opened with openMenu), kept inside the window and keyboard navigable. */
export function ContextMenu() {
  const menu = useApp((st) => st.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
    ref.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
    };
  }, [menu]);

  if (!menu) return null;
  const run = (item: MenuItem) => {
    closeMenu();
    item.run?.();
  };
  return (
    <div ref={ref} className={s.menu} role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className={s.menuSeparator} role="separator" />
        ) : item.custom ? (
          <div key={i}>{item.custom}</div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cx(s.menuItem, item.danger && s.menuDanger)}
            onClick={() => run(item)}
          >
            <span className={cx(s.menuIcon, item.checked && s.menuCheck)}>{item.checked ? <Checkmark12Regular /> : item.icon}</span>
            <span>{item.label}</span>
            <span className={s.menuShortcut}>{item.shortcut}</span>
          </button>
        ),
      )}
    </div>
  );
}
