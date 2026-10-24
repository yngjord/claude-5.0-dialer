import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * How many of this user's callbacks are due now. Callbacks only ever belong to the rep who booked them. Checks every
 * minute (callbacks become due by the clock) and whenever a wrap-up is saved ('callbacks:changed').
 */
export function useDueCallbacks(userId: string | undefined): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      const { count: due } = await supabase
        .from('dialer_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'callback')
        .eq('callback_user_id', userId)
        .lte('next_attempt_at', new Date().toISOString());
      if (!cancelled) setCount(due ?? 0);
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener('callbacks:changed', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('callbacks:changed', load);
    };
  }, [userId]);

  return count;
}
