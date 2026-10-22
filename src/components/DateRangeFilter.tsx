import { RANGE_LABELS, type DateRange, type RangePreset } from '../lib/dateRange';
import { sydneyToday } from '../lib/format';

/** Preset picker; 'Custom dates' shows from/to date fields (whole days, Sydney time). */
export function DateRangeFilter({ value, onChange, presets }: { value: DateRange; onChange: (r: DateRange) => void; presets: RangePreset[] }) {
  const field = 'field !w-auto !rounded-full !py-2 text-sm';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Date range" className={field} value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value as RangePreset })}>
        {presets.map((p) => (
          <option key={p} value={p}>
            {RANGE_LABELS[p]}
          </option>
        ))}
      </select>
      {value.preset === 'custom' && (
        <span className="flex items-center gap-2 text-sm text-ink-muted">
          <input type="date" aria-label="From" className={field} value={value.from} max={sydneyToday()} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          to
          <input type="date" aria-label="To" className={field} value={value.to} max={sydneyToday()} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}
