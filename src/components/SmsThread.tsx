import { Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SmsMessage, SmsSendRequest } from '../../shared/types';
import { api, must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

/** A text conversation with one number, live-updating, with a reply box. */
export function SmsThread({ phone, contactId }: { phone: string; contactId?: string | null }) {
  const { data, setData, loading, error } = useLoad(
    async () => must(await supabase.from('dialer_sms_messages').select('*').eq('phone_e164', phone).order('created_at').limit(500)) as SmsMessage[],
    [phone],
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const channel = supabase
      .channel(`sms-${phone}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialer_sms_messages', filter: `phone_e164=eq.${phone}` }, (payload) => {
        const msg = payload.new as SmsMessage;
        if (!msg?.id) return;
        setData((list) => {
          const rest = (list ?? []).filter((m) => m.id !== msg.id);
          return [...rest, msg].sort((a, b) => a.created_at.localeCompare(b.created_at));
        });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [phone, setData]);

  // Opening the thread marks its incoming texts as read.
  const unread = data?.filter((m) => m.direction === 'inbound' && !m.read_at).map((m) => m.id) ?? [];
  const unreadKey = unread.join(',');
  useEffect(() => {
    if (!unreadKey) return;
    supabase.from('dialer_sms_messages').update({ read_at: new Date().toISOString() }).in('id', unreadKey.split(',')).then(() => window.dispatchEvent(new Event('inbox:changed')));
  }, [unreadKey]);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [data?.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const body: SmsSendRequest = { to: phone, body: text, contactId };
      const msg = await api<SmsMessage>('sms', { method: 'POST', body: JSON.stringify(body) });
      setData((list) => [...(list ?? []).filter((m) => m.id !== msg.id), msg]);
      setText('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-[200px] flex-1 space-y-2 overflow-y-auto py-2">
        {loading ? (
          <div className="flex justify-center py-10 text-brand">
            <Spinner />
          </div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-red-600">{error}</p>
        ) : !data?.length ? (
          <p className="py-10 text-center text-sm text-ink-faint">No messages yet.</p>
        ) : (
          data.map((m) => (
            <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-3xl px-4 py-2.5 text-[15px] ${m.direction === 'outbound' ? 'rounded-br-lg bg-brand text-white' : 'rounded-bl-lg bg-neutral-100'}`}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={`mt-1 text-[11px] ${m.direction === 'outbound' ? 'text-white/70' : 'text-ink-faint'}`}>
                  {formatDateTime(m.created_at)}
                  {m.direction === 'outbound' && m.status && ` · ${m.status}`}
                  {m.error && ` · ${m.error}`}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="mt-3 flex items-end gap-2 border-t border-line pt-3">
        <label htmlFor={`sms-${phone}`} className="sr-only">
          Message
        </label>
        <textarea
          id={`sms-${phone}`}
          rows={2}
          className="field resize-none"
          placeholder="Write a text…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={sending || !text.trim()} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-hover disabled:opacity-50" aria-label="Send">
          {sending ? <Spinner /> : <Send size={18} />}
        </button>
      </form>
      {sendError && <p className="mt-2 text-sm text-red-600">{sendError}</p>}
      <p className="mt-1 text-right text-[11px] text-ink-faint tabular-nums">{text.length}/1600</p>
    </div>
  );
}

export function SmsThreadModal({ phone, contactId, title, onClose }: { phone: string; contactId?: string | null; title: string; onClose: () => void }) {
  return (
    <Modal title={`Texts with ${title}`} onClose={onClose} size="lg">
      <div className="flex h-[60vh] flex-col">
        <SmsThread phone={phone} contactId={contactId} />
      </div>
    </Modal>
  );
}
