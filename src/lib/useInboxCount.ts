import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/**
 * Unread texts + unheard voicemails. The Inbox is admin-only, so this counts everyone's (pass no id to turn it off,
 * e.g. for team members). Updates live, and when the inbox marks things read.
 */
export function useInboxCount(userId: string | undefined): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      const [sms, vm] = await Promise.all([
        supabase.from('dialer_sms_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound').is('read_at', null),
        supabase.from('dialer_calls').select('id', { count: 'exact', head: true }).eq('kind', 'voicemail').is('read_at', null),
      ]);
      if (!cancelled) setCount((sms.count ?? 0) + (vm.count ?? 0));
    };
    load();
    const channel = supabase
      .channel('inbox-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_sms_messages' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_calls' }, (p) => {
        if ((p.new as { kind?: string })?.kind === 'voicemail') load();
      })
      .subscribe();
    window.addEventListener('inbox:changed', load);
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.removeEventListener('inbox:changed', load);
    };
  }, [userId]);

  return count;
}
