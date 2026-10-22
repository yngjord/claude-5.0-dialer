import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react';

type Variant = 'primary' | 'outline' | 'ghost';
type Size = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition duration-200 ease-out disabled:pointer-events-none disabled:opacity-50';
const variants: Record<Variant, string> = {
  primary: 'border border-brand bg-brand text-white hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-btn active:translate-y-0',
  outline: 'border border-line-border bg-white/70 text-ink hover:border-brand hover:text-brand',
  ghost: 'text-ink-muted hover:bg-black/[0.04] hover:text-ink',
};
const sizes: Record<Size, string> = {
  sm: 'h-10 px-5 text-[15px]',
  md: 'h-[50px] px-7 text-[16px]',
};

function buttonClass(variant: Variant = 'primary', size: Size = 'sm', extra = '') {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`;
}

export function Button({
  variant = 'primary',
  size = 'sm',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant = 'primary',
  size = 'sm',
  className = '',
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return <a className={buttonClass(variant, size, className)} {...props} />;
}
