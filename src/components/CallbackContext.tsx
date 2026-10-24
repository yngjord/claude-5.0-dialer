import { CalendarClock } from 'lucide-react';
import type { CallRow, Contact } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';

/** For a contact being called back: when it was booked for, and the notes from the call that booked it. */
export function CallbackContext({ contact }: { contact: Contact }) {
  const booked = useLoad(
    async () =>
      must(
        await supabase
          .from('dialer_calls')
          .select('started_at, notes, agent_name')
          .eq('contact_id', contact.id)
          .eq('disposition', 'Callback')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as Pick<CallRow, 'started_at' | 'notes' | 'agent_name'> | null,
    [contact.id],
  );

  return (
    <div className="mx-auto mb-6 max-w-xl rounded-2xl border border-purple-200 bg-purple-50/60 px-4 py-3 text-left text-sm">
      <p className="flex items-center gap-2 font-medium text-purple-900">
        <CalendarClock size={16} /> Callback{contact.next_attempt_at ? ` booked for ${formatDateTime(contact.next_attempt_at)}` : ''}
      </p>
      {booked.loading ? (
        <div className="skeleton mt-2 h-4 w-2/3" />
      ) : booked.data ? (
        <>
          <p className="mt-1 text-xs text-purple-900/70">From your call on {formatDateTime(booked.data.started_at)}</p>
          <p className="mt-2 whitespace-pre-wrap text-ink-soft">{booked.data.notes || 'No notes were left on that call.'}</p>
        </>
      ) : null}
    </div>
  );
}
