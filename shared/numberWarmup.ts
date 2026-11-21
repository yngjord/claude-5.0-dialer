/**
 * Caller-number warm-up. A new number makes a limited number of calls a day for its first three weeks of dialling
 * (day 1 = the first Sydney day it dialled), so carriers and caller-ID apps don't flag it as spam. The database
 * enforces it when picking the number for each dial (dialer_pick_caller); this mirrors it for the admin screens.
 */
export function warmupCap(day: number): number | null {
  if (day <= 7) return 30;
  if (day <= 14) return 60;
  if (day <= 21) return 100;
  return null;
}

/** One number's row from dialer_number_usage(). */
export interface NumberUsage {
  number_id: string;
  e164: string;
  created_at: string;
  first_dial_day: string | null;
  warmup_day: number;
  dials_today: number;
  daily_cap: number | null;
}

/** "Warming up · day 3 of 21 · 12/30 today", "Ready · 18 today", or "New · starts at 30 a day". */
export function warmupLabel(u: NumberUsage | undefined): { text: string; tone: 'green' | 'amber' | 'grey' } {
  if (!u) return { text: '', tone: 'grey' };
  if (!u.first_dial_day) return { text: `New · starts at ${warmupCap(1)} calls a day`, tone: 'grey' };
  if (u.daily_cap == null) return { text: `Ready · ${u.dials_today} today`, tone: 'green' };
  const full = u.dials_today >= u.daily_cap;
  return {
    text: `Warming up · day ${u.warmup_day} of 21 · ${u.dials_today}/${u.daily_cap} today${full ? ' (full, others take over)' : ''}`,
    tone: 'amber',
  };
}
