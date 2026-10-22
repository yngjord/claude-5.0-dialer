import { ArrowLeft, Voicemail } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatPhone } from '../../shared/phone';
import type { CallRow, SmsMessage } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { CallDetailModal } from '../components/CallDetail';
import { SmsThread } from '../components/SmsThread';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { Tabs } from '../components/ui/Tabs';
import { must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';

type Msg = SmsMessage & { contact: { full_name: string | null; company: string | null } | null };
interface Thread {
  phone: string;
  name: string | null;
  company: string | null;
  contactId: string | null;
  last: Msg;
  unread: number;
}

export default function Inbox() {
  const [tab, setTab] = useState<'texts' | 'voicemails'>('texts');
  return (
    <>
      <PageHeader title="Inbox" subtitle="Texts and voicemails from prospects. You're notified about people you last called or texted." />
      <div className="mb-5 animate-appear">
        <Tabs
          label="Inbox"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'texts', label: 'Texts' },
            { value: 'voicemails', label: 'Voicemails' },
          ]}
        />
      </div>
      {tab === 'texts' ? <Texts /> : <Voicemails />}
    </>
  );
}

function Texts() {
  const { me } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(
    async () =>
      must(
        await supabase.from('dialer_sms_messages').select('*, contact:dialer_contacts(full_name, company)').order('created_at', { ascending: false }).limit(1000),
      ) as Msg[],
    [],
  );

  useEffect(() => {
    const channel = supabase
      .channel('inbox-texts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_sms_messages' }, () => reload({ quiet: true }))
      .subscribe();
    const onChange = () => reload({ quiet: true });
    window.addEventListener('inbox:changed', onChange);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('inbox:changed', onChange);
    };
  }, [reload]);

  const threads = useMemo(() => {
    const byPhone = new Map<string, Thread>();
    for (const m of data ?? []) {
      const t = byPhone.get(m.phone_e164) ?? { phone: m.phone_e164, name: null, company: null, contactId: null, last: m, unread: 0 };
      t.name ??= m.contact?.full_name ?? null;
      t.company ??= m.contact?.company ?? null;
      t.contactId ??= m.contact_id;
      if (m.direction === 'inbound' && !m.read_at && m.user_id === me?.userId) t.unread++;
      byPhone.set(m.phone_e164, t);
    }
    return [...byPhone.values()];
  }, [data, me?.userId]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  const thread = threads.find((t) => t.phone === selected);

  return (
    <section className="card grid animate-appear overflow-hidden lg:h-[calc(100vh-260px)] lg:min-h-[480px] lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className={`overflow-y-auto border-line lg:border-r ${thread ? 'hidden lg:block' : ''}`}>
        {loading ? (
          <div className="p-5">
            <LoadingRows rows={4} label="Loading texts…" />
          </div>
        ) : !threads.length ? (
          <p className="p-8 text-center text-sm text-ink-faint">No texts yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((t) => (
              <li key={t.phone}>
                <button onClick={() => setSelected(t.phone)} className={`w-full px-5 py-4 text-left transition hover:bg-neutral-50 ${selected === t.phone ? 'bg-brand-tint' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate ${t.unread ? 'font-semibold' : 'font-medium'}`}>{t.name || formatPhone(t.phone)}</span>
                    <span className="shrink-0 text-xs text-ink-faint">{formatDateTime(t.last.created_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className="truncate text-sm text-ink-muted">
                      {t.last.direction === 'outbound' && 'You: '}
                      {t.last.body}
                    </p>
                    {t.unread > 0 && <span className="ml-auto rounded-full bg-amber-400 px-2 text-xs font-semibold tabular-nums">{t.unread}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`flex min-h-[420px] flex-col p-4 sm:p-6 ${thread ? '' : 'hidden lg:flex'}`}>
        {thread ? (
          <>
            <div className="mb-2 flex items-center gap-3 border-b border-line pb-3">
              <button onClick={() => setSelected(null)} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 lg:hidden" aria-label="Back to conversations">
                <ArrowLeft size={18} />
              </button>
              <div className="min-w-0">
                <p className="truncate font-display text-lg font-medium">{thread.name || formatPhone(thread.phone)}</p>
                <p className="truncate text-sm text-ink-muted">{[formatPhone(thread.phone), thread.company].filter(Boolean).join(' · ')}</p>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <SmsThread key={thread.phone} phone={thread.phone} contactId={thread.contactId} />
            </div>
          </>
        ) : (
          <p className="m-auto text-sm text-ink-faint">Choose a conversation.</p>
        )}
      </div>
    </section>
  );
}

function Voicemails() {
  const { me } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(
    async () => must(await supabase.from('dialer_calls').select('*').eq('kind', 'voicemail').order('started_at', { ascending: false }).limit(200)) as CallRow[],
    [],
  );

  useEffect(() => {
    const onChange = () => reload({ quiet: true });
    window.addEventListener('inbox:changed', onChange);
    return () => window.removeEventListener('inbox:changed', onChange);
  }, [reload]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <section className="card animate-appear p-4 sm:p-6">
      {loading ? (
        <LoadingRows rows={4} label="Loading voicemails…" />
      ) : (
        <table className="w-full">
          <tbody className="divide-y divide-line">
            {!data?.length ? (
              <EmptyRow colSpan={4}>No voicemails yet.</EmptyRow>
            ) : (
              data.map((v) => {
                const unread = !v.read_at && v.user_id === me?.userId;
                return (
                  <tr key={v.id} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpen(v.id)}>
                    <td className="td w-8">
                      <Voicemail size={18} className={unread ? 'text-amber-500' : 'text-ink-faint'} aria-label={unread ? 'New' : undefined} />
                    </td>
                    <td className="td">
                      <p className={unread ? 'font-semibold' : 'font-medium'}>{v.full_name || formatPhone(v.phone_e164)}</p>
                      <p className="max-w-[420px] truncate text-xs text-ink-muted">
                        {v.transcript ? v.transcript.replace(/^Caller: /gm, '') : v.recording_sid ? 'Message left' : 'Hung up without a message'}
                      </p>
                    </td>
                    <td className="td hidden text-ink-muted sm:table-cell">{v.campaign_name ?? ''}</td>
                    <td className="td text-right tabular-nums text-ink-muted">
                      {formatDateTime(v.started_at)}
                      {v.recording_duration_s ? ` · ${formatDuration(v.recording_duration_s)}` : ''}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
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
  );
}
