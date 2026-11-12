import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
  children: ReactNode;
}

function classes(variant: Variant, size: Size, extra?: string) {
  return ['rr-button', `rr-button--${variant}`, `rr-button--${size}`, extra].filter(Boolean).join(' ');
}

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconPosition = 'start',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const visual = loading ? <LoaderCircle className="rr-spin" size={16} aria-hidden="true" /> : icon;
  return (
    <button
      type={type}
      className={classes(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {iconPosition === 'start' && visual}
      <span>{children}</span>
      {iconPosition === 'end' && visual}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps, Omit<LinkProps, 'children'> {}

export function ButtonLink({ variant = 'secondary', size = 'md', icon, iconPosition = 'start', className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={classes(variant, size, className)} {...rest}>
      {iconPosition === 'start' && icon}
      <span>{children}</span>
      {iconPosition === 'end' && icon}
    </Link>
  );
}
