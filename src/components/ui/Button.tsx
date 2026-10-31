import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'sm';
  block?: boolean;
  icon?: LucideIcon;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  icon: Icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [
    'z-btn',
    variant !== 'default' && `z-btn--${variant}`,
    size === 'sm' && 'z-btn--sm',
    block && 'z-btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  size?: 'md' | 'sm';
  shortcut?: string;
}

/** Icon-only button. `label` is used for both the accessible name and the tooltip. */
export function IconButton({
  icon: Icon,
  label,
  pressed,
  size = 'md',
  shortcut,
  className = '',
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={`z-icon-btn ${size === 'sm' ? 'z-icon-btn--sm' : ''} ${className}`}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      <Icon size={size === 'sm' ? 14 : 17} aria-hidden />
    </button>
  );
}
