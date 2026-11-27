import { Clock } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseTime, TIME_OPTIONS, timeLabel } from '../../../shared/timeInput';

/**
 * A time box: click for a list of times every 15 minutes (opened at the chosen time, or 9 am), or type it the way you'd
 * say it ("2:30", "230pm", "14:30", "9") and press Enter. Replaces the browser's hour / minute / AM-PM columns.
 */
export function TimeSelect({ value, onChange, id, ariaLabel, className = '' }: { value: string; onChange: (v: string) => void; id?: string; ariaLabel?: string; className?: string }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ? timeLabel(value) : '');
  const [active, setActive] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // The box shows the chosen time; while typing it shows what's typed.
  useEffect(() => {
    if (!open) setText(value ? timeLabel(value) : '');
  }, [value, open]);

  const typed = open && text && text !== (value ? timeLabel(value) : '') ? parseTime(text) : null;
  // Typed something that isn't on the list (e.g. 2:07 pm): offer it first.
  const shown = useMemo(() => {
    const options = value && !TIME_OPTIONS.includes(value) ? [...TIME_OPTIONS, value].sort() : TIME_OPTIONS;
    return typed && !options.includes(typed) ? [typed, ...options] : options;
  }, [value, typed]);

  // Opening (or typing) scrolls the list to the chosen, typed or nearest time.
  const target = typed ?? active ?? value ?? '09:00';
  useEffect(() => {
    if (!open || !list.current) return;
    const near = shown.find((t) => t >= target) ?? shown[shown.length - 1];
    const el = list.current.querySelector<HTMLElement>(`[data-time="${near}"]`);
    if (el) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 2 + el.clientHeight / 2;
  }, [open, target, shown]);

  const choose = (t: string) => {
    onChange(t);
    setText(timeLabel(t));
    setActive(null);
    setOpen(false);
  };

  return (
    <div ref={box} className={`relative ${className}`}>
      <div className="relative">
        <Clock size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input
          id={id}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          className="field !pl-10"
          placeholder="e.g. 2:30pm"
          value={text}
          onFocus={(e) => {
            setOpen(true);
            e.currentTarget.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setActive(null);
            setOpen(true);
          }}
          onBlur={(e) => {
            // Clicking a time in the list keeps focus inside: that click chooses it.
            if (box.current?.contains(e.relatedTarget as Node)) return;
            const t = parseTime(text);
            if (t) onChange(t);
            setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setText(value ? timeLabel(value) : '');
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const t = active ?? typed ?? parseTime(text);
              if (t) choose(t);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              const from = active ?? typed ?? value ?? '09:00';
              const i = shown.indexOf(shown.find((t) => t >= from) ?? shown[0]);
              const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? (active ? 1 : 0) : -1)))];
              setActive(next);
              setText(timeLabel(next));
            }
          }}
        />
      </div>
      {open && (
        <ul ref={list} id={listId} role="listbox" className="absolute z-30 mt-1 max-h-60 w-full min-w-[160px] overflow-y-auto rounded-2xl border border-line bg-white p-1 shadow-lg">
          {shown.map((t) => {
            const selected = t === (active ?? typed ?? value);
            return (
              <li key={t} data-time={t} role="option" aria-selected={selected}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(t)}
                  className={`w-full rounded-xl px-3 py-1.5 text-left text-sm tabular-nums transition ${selected ? 'bg-brand text-white' : 'hover:bg-brand-tint hover:text-brand'}`}
                >
                  {timeLabel(t)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
