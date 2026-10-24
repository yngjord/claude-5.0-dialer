import { CalendarClock, PhoneOutgoing } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatPhone } from '../../shared/phone';
import type { CallRow, Campaign, Contact } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { Badge } from '../components/ui/Badge';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';

type Row = Contact & { campaign: Pick<Campaign, 'name' | 'status'> | null };

/**
 * The logged-in user's callbacks (booked with the Callback disposition; nobody else sees them), soonest first, with
 * the notes from the call that booked each one. Due callbacks come up first in that campaign's dialer.
 */
export default function Callbacks() {
  const { me } = useAuth();
  const list = useLoad(async () => {
    if (!me) return [];
    const contacts = must(
      await supabase
        .from('dialer_contacts')
        .select('*, campaign:dialer_campaigns(name, status)')
        .eq('status', 'callback')
        .eq('callback_user_id', me.userId)
        .order('next_attempt_at'),
    ) as Row[];
    if (!contacts.length) return [];
    const calls = must(
      await supabase
        .from('dialer_calls')
        .select('contact_id, notes, started_at')
        .in(
          'contact_id',
          contacts.map((c) => c.id),
        )
        .eq('disposition', 'Callback')
        .order('started_at', { ascending: false }),
    ) as Pick<CallRow, 'contact_id' | 'notes' | 'started_at'>[];
    const notes = new Map<string, string | null>();
    calls.forEach((c) => c.contact_id && !notes.has(c.contact_id) && notes.set(c.contact_id, c.notes));
    return contacts.map((c) => ({ ...c, bookedNotes: notes.get(c.id) ?? null }));
  }, [me?.userId]);

  const now = Date.now();

  return (
    <>
      <PageHeader title="Callbacks" subtitle="Calls you've booked to make again. Once one is due, it comes up first when you dial that campaign." />

      <section className="card animate-appear p-4 sm:p-6">
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <LoadingRows label="Loading callbacks…" />
        ) : (
          <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[860px]">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Call back</th>
                  <th className="th">Contact</th>
                  <th className="th">Campaign</th>
                  <th className="th">Notes from the call</th>
                  <th className="th" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!list.data?.length ? (
                  <EmptyRow colSpan={5}>No callbacks booked. Choose Callback as the disposition after a call to book one.</EmptyRow>
                ) : (
                  list.data.map((c) => {
                    const due = !!c.next_attempt_at && new Date(c.next_attempt_at).getTime() <= now;
                    const dialable = c.campaign?.status === 'active';
                    return (
                      <tr key={c.id} className="align-top">
                        <td className="td whitespace-nowrap">
                          <p className="flex items-center gap-1.5 tabular-nums">
                            <CalendarClock size={15} className="text-ink-faint" /> {formatDateTime(c.next_attempt_at)}
                          </p>
                          {due && (
                            <span className="mt-1 inline-block">
                              <Badge tone="purple">Due now</Badge>
                            </span>
                          )}
                        </td>
                        <td className="td">
                          <p className="font-medium">{c.full_name || '—'}</p>
                          <p className="text-xs tabular-nums text-ink-muted">
                            {formatPhone(c.phone_e164)}
                            {c.company ? ` · ${c.company}` : ''}
                          </p>
                        </td>
                        <td className="td max-w-[180px] truncate text-ink-muted">{c.campaign?.name ?? '—'}</td>
                        <td className="td max-w-[320px] whitespace-pre-wrap text-ink-soft">{c.bookedNotes || <span className="text-ink-faint">No notes</span>}</td>
                        <td className="td text-right">
                          {dialable ? (
                            <Link
                              to={`/campaigns/${c.campaign_id}/dial`}
                              className={`inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition ${due ? 'bg-brand text-white hover:bg-brand-hover' : 'border border-line-strong text-ink-muted hover:border-brand hover:text-brand'}`}
                              title={due ? 'Opens the dialer; this callback comes up first' : 'Comes up first in the dialer once it’s due'}
                            >
                              <PhoneOutgoing size={15} /> Dial
                            </Link>
                          ) : (
                            <span className="text-sm text-ink-faint">Campaign {c.campaign?.status ?? 'unavailable'}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
