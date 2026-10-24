import { Activity, ChevronDown, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Fragment, useState } from 'react';
import { formatPhone } from '../../../shared/phone';
import type { AirtableClient, PhoneNumber } from '../../../shared/types';
import { NumberHealth } from '../../components/NumberHealth';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { api, must, useLoad } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { BuyNumberModal } from './BuyNumberModal';
import { TwilioSetupCard } from './TwilioSetupCard';

/**
 * Twilio numbers: which client each number belongs to, the default, and custom voicemail greetings.
 * "Sync from Twilio" imports bought numbers and points their voicemail/SMS webhooks at this site.
 */
export default function Numbers() {
  const list = useLoad(async () => must(await supabase.from('dialer_phone_numbers').select('*').order('e164')) as PhoneNumber[], []);
  const clients = useLoad(() => api<AirtableClient[]>('clients'), []);
  const [syncing, setSyncing] = useState(false);
  const [buying, setBuying] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = async (id: string, fields: Partial<PhoneNumber>) => {
    setError(null);
    if (fields.is_default) {
      const { error } = await supabase.from('dialer_phone_numbers').update({ is_default: false }).neq('id', id);
      if (error) return setError(error.message);
    }
    const { error } = await supabase.from('dialer_phone_numbers').update(fields).eq('id', id);
    if (error) setError(error.message);
    list.reload({ quiet: true });
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api<{ synced: number }>('admin/numbers-sync', { method: 'POST' });
      setMessage(`Synced ${res.synced} number${res.synced === 1 ? '' : 's'} from Twilio.`);
      list.reload({ quiet: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const uploadGreeting = async (n: PhoneNumber, file: File) => {
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3';
    const path = `${n.id}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('dialer-greetings').upload(path, file, { contentType: file.type || 'audio/mpeg' });
    if (error) return setError(error.message);
    if (n.voicemail_greeting_path) await supabase.storage.from('dialer-greetings').remove([n.voicemail_greeting_path]);
    await update(n.id, { voicemail_greeting_path: path });
  };

  const removeGreeting = async (n: PhoneNumber) => {
    if (n.voicemail_greeting_path) await supabase.storage.from('dialer-greetings').remove([n.voicemail_greeting_path]);
    await update(n.id, { voicemail_greeting_path: null });
  };

  const playGreeting = async (n: PhoneNumber) => {
    if (!n.voicemail_greeting_path) return;
    const { data } = await supabase.storage.from('dialer-greetings').createSignedUrl(n.voicemail_greeting_path, 300);
    if (data?.signedUrl) new Audio(data.signedUrl).play();
  };

  return (
    <>
      <PageHeader
        title="Phone numbers"
        subtitle="Each client has their own number, shared by every rep on their campaigns."
        actions={
          <>
            <Button variant="outline" onClick={sync} disabled={syncing}>
              {syncing ? <Spinner /> : <RefreshCw size={16} />} Sync from Twilio
            </Button>
            <Button onClick={() => setBuying(true)}>
              <Plus size={16} /> Buy number
            </Button>
          </>
        }
      />

      <TwilioSetupCard />

      {message && <p className="mb-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
      {error && (
        <p role="alert" className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="card animate-appear p-4 sm:p-6">
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <LoadingRows label="Loading numbers…" />
        ) : (
          <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[860px]">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Number</th>
                  <th className="th">Label</th>
                  <th className="th">Client</th>
                  <th className="th">Default</th>
                  <th className="th">Voicemail greeting</th>
                  <th className="th text-right">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!list.data?.length ? (
                  <EmptyRow colSpan={6}>No numbers yet. Use Buy number, or Sync from Twilio if you bought them in Twilio directly.</EmptyRow>
                ) : (
                  list.data.map((n) => (
                    <Fragment key={n.id}>
                    <tr>
                      <td className="td font-medium tabular-nums">{formatPhone(n.e164)}</td>
                      <td className="td">
                        <input
                          aria-label={`Label for ${n.e164}`}
                          className="field !w-44 !py-2 text-sm"
                          defaultValue={n.label ?? ''}
                          onBlur={(e) => e.target.value !== (n.label ?? '') && update(n.id, { label: e.target.value || null })}
                        />
                      </td>
                      <td className="td">
                        <select
                          aria-label={`Client for ${n.e164}`}
                          className="field !w-52 !py-2 text-sm"
                          value={n.client_name ?? ''}
                          onChange={(e) => update(n.id, { client_name: e.target.value || null })}
                        >
                          <option value="">{clients.loading ? 'Loading…' : 'No client'}</option>
                          {/* Keep a saved name selectable even if it's no longer in Airtable. */}
                          {n.client_name && !clients.data?.some((c) => c.name === n.client_name) && <option value={n.client_name}>{n.client_name}</option>}
                          {clients.data?.map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="td">
                        {n.is_default ? (
                          <Badge tone="blue">Default</Badge>
                        ) : (
                          <button onClick={() => update(n.id, { is_default: true })} className="text-sm text-brand hover:underline">
                            Make default
                          </button>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-3 text-sm">
                          {n.voicemail_greeting_path ? (
                            <>
                              <button onClick={() => playGreeting(n)} className="text-brand hover:underline">
                                Play custom
                              </button>
                              <button onClick={() => removeGreeting(n)} className="text-ink-muted hover:text-red-600" aria-label="Remove greeting">
                                <Trash2 size={15} />
                              </button>
                            </>
                          ) : (
                            <span className="text-ink-faint">Standard</span>
                          )}
                          <label className="inline-flex cursor-pointer items-center gap-1 text-brand hover:underline">
                            <Upload size={14} /> Upload
                            <input type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadGreeting(n, e.target.files[0])} />
                          </label>
                        </div>
                      </td>
                      <td className="td text-right">
                        <button
                          onClick={() => setOpen(open === n.id ? null : n.id)}
                          aria-expanded={open === n.id}
                          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-brand hover:bg-brand-tint"
                        >
                          <Activity size={15} /> Pickup rate <ChevronDown size={15} className={`transition-transform ${open === n.id ? 'rotate-180' : ''}`} />
                        </button>
                      </td>
                    </tr>
                    {open === n.id && (
                      <tr>
                        <td colSpan={6} className="bg-neutral-50/60 px-4 py-5 sm:px-6">
                          <NumberHealth e164={n.e164} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {buying && (
        <BuyNumberModal
          onClose={() => setBuying(false)}
          onBought={(n) => {
            setBuying(false);
            setMessage(`Bought ${formatPhone(n.e164)} for ${n.client_name}. It's ready for their campaigns.`);
            list.reload({ quiet: true });
          }}
        />
      )}
    </>
  );
}
