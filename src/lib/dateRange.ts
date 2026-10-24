import { addDays, sydneyMidnight, sydneyToday } from './format';

export type RangePreset = 'today' | 'month' | 'lastMonth' | '7' | '30' | '90' | 'all' | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** YYYY-MM-DD, Sydney time. Used when preset is 'custom'. */
  from: string;
  to: string;
}

export const RANGE_LABELS: Record<RangePreset, string> = { today: 'Today', month: 'This month', lastMonth: 'Last month', '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days', all: 'All time', custom: 'Custom dates' };

export const defaultRange = (preset: RangePreset = '7'): DateRange => ({ preset, from: addDays(sydneyToday(), -6), to: sydneyToday() });

/** The range as ISO instants, [from, to). Null bounds mean open-ended ('All time'). */
export function rangeBounds(r: DateRange): { from: string | null; to: string | null } {
  const today = sydneyToday();
  switch (r.preset) {
    case 'all':
      return { from: null, to: null };
    case 'today':
      return { from: sydneyMidnight(today), to: null };
    case 'month':
      return { from: sydneyMidnight(`${today.slice(0, 8)}01`), to: null };
    case 'lastMonth': {
      const [y, m] = today.split('-').map(Number);
      const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
      return { from: sydneyMidnight(prev), to: sydneyMidnight(`${today.slice(0, 8)}01`) };
    }
    case 'custom': {
      const [from, to] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from];
      return { from: sydneyMidnight(from), to: sydneyMidnight(addDays(to, 1)) };
    }
    default:
      return { from: sydneyMidnight(addDays(today, -(Number(r.preset) - 1))), to: null };
  }
}
