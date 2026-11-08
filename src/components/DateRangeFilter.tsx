import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RANGE_LABELS, type DateRange, type RangePreset } from '../lib/dateRange';
import { sydneyToday } from '../lib/format';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** "2026-10-03" → "3 Oct 2026" (or "3 Oct" in the current year). */
function short(date: string, withYear: boolean) {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

/**
 * Preset picker. "Custom dates" opens one calendar: click the first day, then the last (like check-in / check-out),
 * with the days between highlighted. Whole days, Sydney time; nothing after today.
 */
export function DateRangeFilter({ value, onChange, presets }: { value: DateRange; onChange: (r: DateRange) => void; presets: RangePreset[] }) {
  const field = 'field !w-auto !rounded-full !py-2 text-sm';
  const [open, setOpen] = useState(false);
  const thisYear = sydneyToday().slice(0, 4);
  const withYear = value.from.slice(0, 4) !== thisYear || value.to.slice(0, 4) !== thisYear;

  return (
    // Raised while the calendar is open, so it sits above the cards below (their entrance animation layers them).
    <div className={`relative flex flex-wrap items-center gap-2 ${open ? 'z-40' : ''}`}>
      <select
        aria-label="Date range"
        className={field}
        value={value.preset}
        onChange={(e) => {
          const preset = e.target.value as RangePreset;
          onChange({ ...value, preset });
          setOpen(preset === 'custom');
        }}
      >
        {presets.map((p) => (
          <option key={p} value={p}>
            {RANGE_LABELS[p]}
          </option>
        ))}
      </select>
      {value.preset === 'custom' && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${field} inline-flex items-center gap-2`}>
          <CalendarDays size={15} className="text-ink-muted" />
          {value.from === value.to ? short(value.from, withYear) : `${short(value.from, withYear)} – ${short(value.to, withYear)}`}
        </button>
      )}
      {open && value.preset === 'custom' && (
        <RangeCalendar
          from={value.from}
          to={value.to}
          onDone={(from, to) => {
            onChange({ ...value, from, to });
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function RangeCalendar({ from, to, onDone, onClose }: { from: string; to: string; onDone: (from: string, to: string) => void; onClose: () => void }) {
  const today = sydneyToday();
  const ref = useRef<HTMLDivElement>(null);
  // The month on show, starting on the current range's end.
  const [view, setView] = useState(() => ({ y: Number(to.slice(0, 4)), m: Number(to.slice(5, 7)) }));
  // First click picks the start; the second picks the end and closes. Until then the hovered day previews the range.
  const [start, setStart] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const daysInMonth = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => ymd(view.y, view.m, i + 1))] as (string | null)[];
  const shift = (n: number) => setView((v) => {
    const m = v.m + n;
    return { y: v.y + Math.floor((m - 1) / 12), m: ((((m - 1) % 12) + 12) % 12) + 1 };
  });
  const canNext = ymd(view.y, view.m, 1) < `${today.slice(0, 8)}01`;

  // What's highlighted: the picked range, or while picking, from the first click to the hovered day.
  const [lo, hi] = start ? [start, hover ?? start].sort() : [from, to];

  const pick = (day: string) => {
    if (!start) return setStart(day);
    const [a, b] = [start, day].sort();
    onDone(a, b);
  };

  return (
    <div ref={ref} role="dialog" aria-label="Choose dates" className="absolute left-0 top-full z-40 mt-2 w-[300px] rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <button type="button" onClick={() => shift(-1)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-neutral-100" aria-label="Previous month">
          <ChevronLeft size={16} />
        </button>
        <p className="font-display text-[15px] font-medium">
          {new Date(Date.UTC(view.y, view.m - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
        </p>
        <button type="button" onClick={() => shift(1)} disabled={!canNext} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-neutral-100 disabled:opacity-30" aria-label="Next month">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-ink-muted">
        {WEEKDAYS.map((d) => (
          <span key={d} className="pb-2">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1" onMouseLeave={() => setHover(null)}>
        {cells.map((day, i) => {
          if (!day) return <span key={`e${i}`} />;
          const future = day > today;
          const inRange = day >= lo && day <= hi;
          const edge = day === lo || day === hi;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              onClick={() => pick(day)}
              onMouseEnter={() => setHover(day)}
              className={`h-9 text-sm tabular-nums transition-colors disabled:text-ink-faint/50 ${
                edge ? 'rounded-full bg-brand font-medium text-white' : inRange ? 'bg-brand-tint text-brand' : 'rounded-full hover:bg-neutral-100'
              } ${day === today && !edge ? 'font-semibold' : ''}`}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-center text-xs text-ink-muted">{start ? 'Now pick the last day' : 'Pick the first day'}</p>
    </div>
  );
}
