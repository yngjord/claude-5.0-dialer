import { PhoneMissed, Voicemail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatPhone } from '../../shared/phone';
import type { CallRow } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { CallDetailModal } from '../components/CallDetail';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';

/**
 * Calls back from prospects: there are no live inbound calls, so callers hear the number's greeting and can leave a
 * message (recorded and transcribed). Each one goes to the rep who last called that number; admins see them all.
 * Bold = not yet opened; opening one marks it heard.
 */
export default function Voicemails() {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(
    async () => must(await supabase.from('dialer_calls').select('*').eq('kind', 'voicemail').order('started_at', { ascending: false }).limit(300)) as CallRow[],
    [],
  );

  useEffect(() => {
    const onChange = () => reload({ quiet: true });
    window.addEventListener('voicemails:changed', onChange);
    const channel = supabase
      .channel('voicemails-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_calls' }, (p) => {
        if ((p.new as { kind?: string })?.kind === 'voicemail') onChange();
      })
      .subscribe();
    return () => {
      window.removeEventListener('voicemails:changed', onChange);
      supabase.removeChannel(channel);
    };
  }, [reload]);

  return (
    <>
      <PageHeader
        title="Voicemails"
        subtitle={isAdmin ? 'Calls back to any of our numbers, with their messages.' : 'Calls back from people you called, with their messages.'}
      />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <section className="card animate-appear p-4 sm:p-6">
          {loading && !data ? (
            <LoadingRows rows={4} label="Loading voicemails…" />
          ) : (
            <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[720px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th w-8" />
                    <th className="th">Caller</th>
                    <th className="th">Called</th>
                    <th className="th">Campaign</th>
                    <th className="th text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {!data?.length ? (
                    <EmptyRow colSpan={5}>No voicemails yet. When someone calls one of our numbers back, it shows here.</EmptyRow>
                  ) : (
                    data.map((v) => {
                      const unread = !v.read_at;
                      // A recording means a message; none means they hung up before the beep.
                      const left = !!(v.recording_sid || v.recording_path);
                      const Icon = left ? Voicemail : PhoneMissed;
                      return (
                        <tr key={v.id} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpen(v.id)}>
                          <td className="td w-8">
                            <Icon size={18} className={unread ? 'text-amber-500' : 'text-ink-faint'} aria-label={unread ? 'New' : undefined} />
                          </td>
                          <td className="td">
                            <p className={unread ? 'font-semibold' : 'font-medium'}>{v.full_name || formatPhone(v.phone_e164)}</p>
                            <p className="max-w-[420px] truncate text-xs text-ink-muted">
                              {v.full_name ? `${formatPhone(v.phone_e164)} · ` : ''}
                              {v.transcript ? v.transcript.replace(/^Caller: /gm, '') : left ? 'Message left' : 'Missed call, no message'}
                            </p>
                          </td>
                          <td className="td whitespace-nowrap tabular-nums text-ink-muted">{v.to_number ? formatPhone(v.to_number) : '—'}</td>
                          <td className="td max-w-[220px] truncate text-ink-muted">{v.campaign_name ?? ''}</td>
                          <td className="td whitespace-nowrap text-right tabular-nums text-ink-muted">
                            {formatDateTime(v.started_at)}
                            {v.recording_duration_s ? ` · ${formatDuration(v.recording_duration_s)}` : ''}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
          {open && (
            <CallDetailModal
              callId={open}
              onClose={() => {
                setOpen(null);
                reload({ quiet: true });
              }}
            />
          )}
        </section>
      )}
    </>
  );
}
