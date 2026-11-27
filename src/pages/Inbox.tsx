import { MessageSquare, PhoneMissed, Voicemail } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatPhone } from '../../shared/phone';
import type { CallRow, DialerUser, SmsMessage } from '../../shared/types';
import { CallDetailModal } from '../components/CallDetail';
import { SmsThreadModal } from '../components/SmsThread';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { Tabs } from '../components/ui/Tabs';
import { must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';

type Tab = 'texts' | 'voicemails';
type TextRow = SmsMessage & { contact: { full_name: string | null; company: string | null; campaign_id: string | null } | null };

/** One conversation: everyone who has texted us, newest first, with how many of their texts haven't been read. */
interface Conversation {
  phone: string;
  name: string | null;
  company: string | null;
  contactId: string | null;
  last: SmsMessage;
  unread: number;
  repId: string | null;
}

function conversations(rows: TextRow[]): Conversation[] {
  const byPhone = new Map<string, Conversation>();
  for (const m of rows) {
    let c = byPhone.get(m.phone_e164);
    if (!c) {
      c = { phone: m.phone_e164, name: null, company: null, contactId: null, last: m, unread: 0, repId: null };
      byPhone.set(m.phone_e164, c);
    }
    if (m.created_at > c.last.created_at) c.last = m;
    if (m.direction === 'inbound' && !m.read_at) c.unread++;
    c.name ??= m.contact?.full_name ?? null;
    c.company ??= m.contact?.company ?? null;
    c.contactId ??= m.contact_id;
    c.repId ??= m.user_id;
  }
  // Only numbers that have texted us: a text we sent with no reply isn't something to act on.
  return [...byPhone.values()].filter((c) => rows.some((m) => m.phone_e164 === c.phone && m.direction === 'inbound')).sort((a, b) => b.last.created_at.localeCompare(a.last.created_at));
}

/**
 * Admins (for now): texts and calls back from prospects. Texts are grouped into conversations (open one to read and
 * reply); voicemails are calls to our numbers, with their message if one was left. Unread ones are bold, counted on
 * each tab and in the note at the top; opening one marks it read.
 */
export default function Inbox() {
  const [tab, setTab] = useState<Tab>('texts');
  const users = useLoad(async () => must(await supabase.rpc('dialer_users')) as DialerUser[], []);
  const repName = (id: string | null) => {
    const u = id ? users.data?.find((x) => x.id === id) : undefined;
    return u ? u.display_name || u.email : '—';
  };

  const texts = useLoad(
    async () =>
      must(
        await supabase
          .from('dialer_sms_messages')
          .select('*, contact:dialer_contacts(full_name, company, campaign_id)')
          .order('created_at', { ascending: false })
          .limit(1000),
      ) as unknown as TextRow[],
    [],
  );
  const voicemails = useLoad(
    async () => must(await supabase.from('dialer_calls').select('*').eq('kind', 'voicemail').order('started_at', { ascending: false }).limit(300)) as CallRow[],
    [],
  );
  const threads = useMemo(() => conversations(texts.data ?? []), [texts.data]);
  const unreadTexts = threads.reduce((n, c) => n + c.unread, 0);
  const unreadVoicemails = (voicemails.data ?? []).filter((v) => !v.read_at).length;

  // New texts and voicemails arrive live; reading one elsewhere (a contact's thread, a call's detail) refreshes the counts.
  const reloadTexts = texts.reload;
  const reloadVoicemails = voicemails.reload;
  useEffect(() => {
    const onTexts = () => reloadTexts({ quiet: true });
    const onVoicemails = () => reloadVoicemails({ quiet: true });
    window.addEventListener('inbox:changed', onTexts);
    window.addEventListener('voicemails:changed', onVoicemails);
    const channel = supabase
      .channel('inbox-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_sms_messages', filter: 'direction=eq.inbound' }, onTexts)
      // Only voicemail rows: listening to every call change kept the database busy during calling.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_calls', filter: 'kind=eq.voicemail' }, onVoicemails)
      .subscribe();
    return () => {
      window.removeEventListener('inbox:changed', onTexts);
      window.removeEventListener('voicemails:changed', onVoicemails);
      supabase.removeChannel(channel);
    };
  }, [reloadTexts, reloadVoicemails]);

  const [openThread, setOpenThread] = useState<Conversation | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);

  const s = (n: number) => (n === 1 ? '' : 's');
  const waiting = [unreadTexts ? `${unreadTexts} unread text${s(unreadTexts)}` : null, unreadVoicemails ? `${unreadVoicemails} new voicemail${s(unreadVoicemails)}` : null].filter(Boolean);

  return (
    <>
      <PageHeader title="Inbox" subtitle="Texts and calls back to any of our numbers. Each shows who last called them." />

      {waiting.length > 0 && (
        <p role="status" className="mb-4 flex animate-appear items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
          You have {waiting.join(' and ')}.
        </p>
      )}

      <div className="mb-4">
        <Tabs
          label="Inbox"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'texts', label: 'Texts', count: unreadTexts || undefined, dot: unreadTexts > 0, dotTitle: `${unreadTexts} unread` },
            { value: 'voicemails', label: 'Voicemails', count: unreadVoicemails || undefined, dot: unreadVoicemails > 0, dotTitle: `${unreadVoicemails} new` },
          ]}
        />
      </div>

      {tab === 'texts' ? (
        texts.error ? (
          <ErrorState message={texts.error} onRetry={texts.reload} />
        ) : (
          <section className="card animate-appear p-4 sm:p-6">
            {texts.loading && !texts.data ? (
              <LoadingRows rows={4} label="Loading texts…" />
            ) : (
              <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[720px]">
                  <thead className="border-b border-line">
                    <tr>
                      <th className="th w-8" />
                      <th className="th">From</th>
                      <th className="th">To</th>
                      <th className="th">Last called by</th>
                      <th className="th text-right">Last message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {!threads.length ? (
                      <EmptyRow colSpan={5}>No texts yet. When someone texts one of our numbers, it shows here.</EmptyRow>
                    ) : (
                      threads.map((c) => {
                        const unread = c.unread > 0;
                        return (
                          <tr key={c.phone} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpenThread(c)}>
                            <td className="td w-8">
                              <MessageSquare size={18} className={unread ? 'text-amber-500' : 'text-ink-faint'} aria-label={unread ? 'Unread' : undefined} />
                            </td>
                            <td className="td">
                              <p className={unread ? 'font-semibold' : 'font-medium'}>
                                {c.name || formatPhone(c.phone)}
                                {c.unread > 1 && <span className="ml-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{c.unread}</span>}
                              </p>
                              <p className="max-w-[420px] truncate text-xs text-ink-muted">
                                {c.name ? `${formatPhone(c.phone)} · ` : ''}
                                {c.last.direction === 'outbound' ? 'You: ' : ''}
                                {c.last.body}
                              </p>
                            </td>
                            <td className="td whitespace-nowrap tabular-nums text-ink-muted">{formatPhone(c.last.our_number)}</td>
                            <td className="td whitespace-nowrap text-ink-muted">{repName(c.repId)}</td>
                            <td className="td whitespace-nowrap text-right tabular-nums text-ink-muted">{formatDateTime(c.last.created_at)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      ) : voicemails.error ? (
        <ErrorState message={voicemails.error} onRetry={voicemails.reload} />
      ) : (
        <section className="card animate-appear p-4 sm:p-6">
          {voicemails.loading && !voicemails.data ? (
            <LoadingRows rows={4} label="Loading voicemails…" />
          ) : (
            <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[720px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th w-8" />
                    <th className="th">Caller</th>
                    <th className="th">Called</th>
                    <th className="th">Last called by</th>
                    <th className="th">Campaign</th>
                    <th className="th text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {!voicemails.data?.length ? (
                    <EmptyRow colSpan={6}>No voicemails yet. When someone calls one of our numbers back, it shows here.</EmptyRow>
                  ) : (
                    voicemails.data.map((v) => {
                      const unread = !v.read_at;
                      // A recording means a message; none means they hung up before the beep.
                      const left = !!(v.recording_sid || v.recording_path);
                      const Icon = left ? Voicemail : PhoneMissed;
                      return (
                        <tr key={v.id} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpenCall(v.id)}>
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
                          <td className="td whitespace-nowrap text-ink-muted">{repName(v.user_id)}</td>
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
        </section>
      )}

      {openThread && (
        <SmsThreadModal
          phone={openThread.phone}
          contactId={openThread.contactId}
          title={openThread.name || formatPhone(openThread.phone)}
          onClose={() => {
            setOpenThread(null);
            texts.reload({ quiet: true });
          }}
        />
      )}
      {openCall && (
        <CallDetailModal
          callId={openCall}
          onClose={() => {
            setOpenCall(null);
            voicemails.reload({ quiet: true });
          }}
        />
      )}
    </>
  );
}
