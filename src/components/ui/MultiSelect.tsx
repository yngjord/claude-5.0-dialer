import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * A filter dropdown where several options can be ticked. Looks like the other filter dropdowns (.field-select gives
 * it the same chevron); nothing ticked means "any".
 */
export function MultiSelect({
  label,
  anyLabel,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  /** Shown when nothing is ticked, e.g. "Any disposition". */
  anyLabel: string;
  /** Plain strings, or { value, label } when what's shown differs from what's stored (e.g. campaign ids). */
  options: readonly (string | { value: string; label: string })[];
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  const labelOf = (v: string) => opts.find((o) => o.value === v)?.label ?? v;
  const summary = !value.length ? anyLabel : value.length === 1 ? labelOf(value[0]) : `${value.length} ${label.toLowerCase()}s`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={`field field-select cursor-pointer whitespace-nowrap text-left ${className}`}
      >
        {summary}
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" aria-label={label} className="absolute left-0 top-full z-40 mt-2 max-h-80 w-max min-w-full overflow-y-auto rounded-2xl border border-line bg-white p-1.5 shadow-card">
          {opts.map(({ value: o, label: text }) => {
            const on = value.includes(o);
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => toggle(o)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-50"
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-brand bg-brand text-white' : 'border-line-strong'}`}>
                  {on && <Check size={12} strokeWidth={3} />}
                </span>
                {text}
              </button>
            );
          })}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="mt-1 w-full border-t border-line px-3 pb-1 pt-2 text-left text-sm text-ink-muted hover:text-ink">
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
