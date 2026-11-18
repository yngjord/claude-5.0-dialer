import { useEffect, useState } from 'react';
import { checkReputation, type NumberReputation, type ReputationCheck } from '../../shared/numberHealth';
import { supabase } from './supabase';

export type NumberAlerts = Map<string, ReputationCheck & NumberReputation>;

/** Each phone number's reputation check (admins only; empty for others or on error). Refreshes every 15 minutes. */
export function useNumberAlerts(enabled: boolean): NumberAlerts {
  const [alerts, setAlerts] = useState<NumberAlerts>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = async () => {
      const { data } = await supabase.rpc('dialer_number_reputation');
      if (live && data) setAlerts(new Map((data as NumberReputation[]).map((r) => [r.number_id, { ...r, ...checkReputation(r) }])));
    };
    load();
    const t = setInterval(load, 15 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enabled]);
  return alerts;
}

/** "Human pickups 8.8% over the last 80 dials vs 16.8% before (48% lower)…" */
export function alertText(a: ReputationCheck & NumberReputation): string {
  const pct = (v: number | null) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  return `Possible spam flag: human pickups ${pct(a.recentRate)} over the last ${a.recent_dials} dials vs ${pct(a.baselineRate)} over the ${a.baseline_dials} before (${Math.round((a.drop ?? 0) * 100)}% lower). Test-call it to an Android and a Samsung phone, and consider resting it for a week or two.`;
}
