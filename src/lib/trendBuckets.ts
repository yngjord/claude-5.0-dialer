import type { DateRange } from './dateRange';
import { addDays, sydneyToday } from './format';

export type BucketSize = 'hour' | 'day' | 'week' | 'month';

export interface TrendBucket {
  /** Matches the bucket text from dialer_performance_trend: 'YYYY-MM-DD', or 'YYYY-MM-DD HH' for hours. */
  key: string;
  /** Short x-axis label and the longer tooltip label. */
  axis: string;
  long: string;
}

const utc = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (day: string, o: Intl.DateTimeFormatOptions) => utc(day).toLocaleDateString('en-AU', { ...o, timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
const mondayOf = (day: string) => addDays(day, -((utc(day).getUTCDay() + 6) % 7));
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
const nextMonth = (first: string) => {
  const [y, m] = first.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

/** The range's first and last Sydney days (inclusive). 'All time' has no first day: the data decides. */
export function rangeDays(r: DateRange, today = sydneyToday()): { from: string | null; to: string } {
  switch (r.preset) {
    case 'all':
      return { from: null, to: today };
    case 'today':
      return { from: today, to: today };
    case 'month':
      return { from: monthOf(today), to: today };
    case 'lastMonth': {
      const thisMonth = monthOf(today);
      return { from: monthOf(addDays(thisMonth, -1)), to: addDays(thisMonth, -1) };
    }
    case 'custom':
      return r.from <= r.to ? { from: r.from, to: r.to } : { from: r.to, to: r.from };
    default:
      return { from: addDays(today, -(Number(r.preset) - 1)), to: today };
  }
}

/** Hours for one day, days up to ~6 weeks, weeks up to ~6 months, then months. */
export function bucketSize(r: DateRange, today = sydneyToday()): BucketSize {
  const { from, to } = rangeDays(r, today);
  if (!from) return 'month';
  const span = daysBetween(from, to) + 1;
  return span <= 1 ? 'hour' : span <= 45 ? 'day' : span <= 200 ? 'week' : 'month';
}

/**
 * Every bucket in the range, empty ones included, so the line shows quiet days as zero. `dataKeys` are the buckets
 * that have calls: they set the start for 'All time' and widen a single day's hours beyond business hours.
 */
export function makeBuckets(r: DateRange, size: BucketSize, dataKeys: string[], today = sydneyToday()): TrendBucket[] {
  const { from: rangeFrom, to } = rangeDays(r, today);
  const sorted = [...dataKeys].sort();
  const from = rangeFrom ?? (sorted[0] ? sorted[0].slice(0, 10) : monthOf(today));
  const out: TrendBucket[] = [];
  if (size === 'hour') {
    const hours = sorted.map((k) => Number(k.slice(11, 13))).filter((h) => !Number.isNaN(h));
    const first = Math.min(8, ...hours);
    const last = Math.max(18, ...hours);
    for (let h = first; h <= last; h++) {
      out.push({ key: `${from} ${String(h).padStart(2, '0')}`, axis: hourLabel(h), long: `${hourLabel(h)}–${hourLabel((h + 1) % 24)}, ${fmt(from, { weekday: 'short', day: 'numeric', month: 'short' })}` });
    }
  } else if (size === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      out.push({ key: d, axis: fmt(d, { day: 'numeric', month: 'short' }), long: fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) });
    }
  } else if (size === 'week') {
    for (let d = mondayOf(from); d <= to; d = addDays(d, 7)) {
      out.push({ key: d, axis: fmt(d, { day: 'numeric', month: 'short' }), long: `Week of ${fmt(d, { day: 'numeric', month: 'short', year: 'numeric' })}` });
    }
  } else {
    for (let d = monthOf(from); d <= to; d = nextMonth(d)) {
      out.push({ key: d, axis: fmt(d, { month: 'short', ...(d.slice(5, 7) === '01' ? { year: '2-digit' } : {}) }), long: fmt(d, { month: 'long', year: 'numeric' }) });
    }
  }
  return out;
}
