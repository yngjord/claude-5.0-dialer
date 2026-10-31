import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * Unheard voicemails (and missed calls) for the sidebar badge: the rep's own, or every one for admins (RLS decides).
 * Updates live, and when the Voicemails page marks one heard.
 */
export function useVoicemailCount(userId: string | undefined): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      const { count: n } = await supabase.from('dialer_calls').select('id', { count: 'exact', head: true }).eq('kind', 'voicemail').is('read_at', null);
      if (!cancelled) setCount(n ?? 0);
    };
    load();
    const channel = supabase
      .channel('voicemail-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_calls' }, (p) => {
        if ((p.new as { kind?: string })?.kind === 'voicemail') load();
      })
      .subscribe();
    window.addEventListener('voicemails:changed', load);
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.removeEventListener('voicemails:changed', load);
    };
  }, [userId]);

  return count;
}
