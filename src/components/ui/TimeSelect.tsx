/** "14:30" → "2:30 pm". */
function label(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// Every 15 minutes through the calling day.
const TIMES = Array.from({ length: (21 - 6) * 4 + 1 }, (_, i) => {
  const minutes = 6 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

/**
 * A time as one dropdown ("9:00 am", "9:15 am"…, 6 am to 9 pm), quicker to pick than the browser's hour/minute/AM-PM
 * time field. A value from elsewhere that isn't on the list (e.g. "In 5 minutes" → 2:07 pm) is shown as its own option.
 */
export function TimeSelect({ value, onChange, id, ariaLabel, className = '' }: { value: string; onChange: (v: string) => void; id?: string; ariaLabel?: string; className?: string }) {
  const options = value && !TIMES.includes(value) ? [...TIMES, value].sort() : TIMES;
  return (
    <select id={id} aria-label={ariaLabel} className={`field ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Choose a time…</option>}
      {options.map((t) => (
        <option key={t} value={t}>
          {label(t)}
        </option>
      ))}
    </select>
  );
}
