import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react';
import s from './ui.module.css';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({
  variant = 'default',
  className,
  ...rest
}: ComponentPropsWithRef<'button'> & { variant?: 'default' | 'primary' | 'danger' | 'subtle' }) {
  return (
    <button type="button" className={cx(s.btn, variant !== 'default' && s[variant], className)} {...rest} />
  );
}

export function IconButton({
  label,
  size = 'md',
  on,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: 'sm' | 'md';
  on?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      className={cx(s.icon, size === 'sm' && s.iconSm, on && s.iconOn, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export { cx };
