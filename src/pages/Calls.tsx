import { Check, FileText, Link2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { DISPOSITIONS, PICKUP_STATUSES, type PickupStatus } from '../../shared/constants';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { MultiSelect } from '../components/ui/MultiSelect';
import { formatPhone } from '../../shared/phone';
import type { CallRow, Campaign } from '../../shared/types';
import { CallDetailModal } from '../components/CallDetail';
import { Badge } from '../components/ui/Badge';
import { SearchInput } from '../components/ui/SearchInput';
import { ServerPagination } from '../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { api, must, useLoad } from '../lib/api';
import { defaultRange, rangeBounds, type DateRange } from '../lib/dateRange';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES, PICKUP_TONES } from '../lib/tones';

const PER_PAGE = 50;

// Pickups where someone or something answered; the rest never connected.
const CONNECTED: PickupStatus[] = ['Human Pickup', 'Machine Pickup', 'Unclassified Pickup'];

export default function Calls() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState<DateRange>(() => defaultRange('7'));
  const bounds = rangeBounds(range);
  const [campaignId, setCampaignId] = useState('');
  const [pickup, setPickup] = useState('');
  const [dispositions, setDispositions] = useState<string[]>([]);
  const [clientName, setClientName] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(0), [bounds.from, bounds.to, campaignId, clientName, pickup, dispositions, debounced]);

  // Campaigns the user can see (reps: theirs), and their clients for the client filter.
  const campaigns = useLoad(
    async () => must(await supabase.from('dialer_campaigns').select('id, name, client_name').order('name')) as Pick<Campaign, 'id' | 'name' | 'client_name'>[],
    [],
  );
  const clients = [...new Set((campaigns.data ?? []).map((c) => c.client_name))].sort((a, b) => a.localeCompare(b));
  const campaignOptions = (campaigns.data ?? []).filter((c) => !clientName || c.client_name === clientName);

  const list = useLoad(async () => {
    let q = supabase
      .from('dialer_calls')
      .select('id, source, started_at, full_name, phone_e164, from_number, campaign_name, agent_name, pickup_status, disposition, notes, duration_s, recording_path, recording_sid, transcript_status', {
        count: 'exact',
      })
      .eq('direction', 'outbound');
    if (bounds.from) q = q.gte('started_at', bounds.from);
    if (bounds.to) q = q.lt('started_at', bounds.to);
    if (campaignId) q = q.eq('campaign_id', campaignId);
    // By the client on the call itself, so JustCall and click-to-call calls (no campaign) are included.
    if (clientName) q = q.eq('client_name', clientName);
    if (pickup) q = q.eq('pickup_status', pickup);
    if (dispositions.length) q = q.in('disposition', dispositions);
    if (debounced) {
      const term = debounced.replace(/[%,()]/g, ' ');
      const digits = term.replace(/\D/g, '');
      q = q.or([`full_name.ilike.%${term}%`, `company.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits.replace(/^0/, '')}%`] : [])].join(','));
    }
    const res = await q.order('started_at', { ascending: false }).range(page * PER_PAGE, page * PER_PAGE + PER_PAGE - 1);
    return { calls: must(res) as CallRow[], total: res.count ?? 0 };
  }, [bounds.from, bounds.to, campaignId, clientName, pickup, dispositions, debounced, page]);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';

  return (
    <>
      <PageHeader title="Call logs" subtitle={isAdmin ? "Every call the team has made, with recordings and transcripts." : "Your calls, with recordings and transcripts."} />

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter value={range} onChange={setRange} presets={['today', 'month', '7', '30', '90', 'all', 'custom']} />
            <select
              aria-label="Client"
              className={select}
              value={clientName}
              onChange={(e) => {
                setClientName(e.target.value);
                setCampaignId('');
              }}
            >
              {/* One client (e.g. a rep on one client's campaigns): just that one, which is every call they can see. */}
              {clients.length === 1 ? (
                <option value="">{clients[0]}</option>
              ) : (
                <>
                  <option value="">All clients</option>
                  {clients.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </>
              )}
            </select>
            <select aria-label="Campaign" className={select} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">All campaigns</option>
              {campaignOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="Pickup status" className={select} value={pickup} onChange={(e) => setPickup(e.target.value)}>
              <option value="">Any pickup</option>
              {PICKUP_STATUSES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <MultiSelect label="Disposition" anyLabel="Any disposition" options={DISPOSITIONS} value={dispositions} onChange={setDispositions} className="!w-auto !rounded-full !py-2 text-sm" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SearchInput value={query} onChange={setQuery} placeholder="Search name, company, phone" />
            {/* How many calls match the filters (all pages). Fades while a new filter loads. */}
            <p className={`text-sm text-ink-muted transition-opacity ${list.loading ? 'opacity-50' : ''}`} aria-live="polite">
              <b className="font-display text-base font-medium tabular-nums text-ink">{(list.data?.total ?? 0).toLocaleString()}</b> call
              {list.data?.total === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <LoadingRows label="Loading calls…" />
        ) : (
          <>
            <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[1180px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Contact</th>
                    <th className="th">Campaign</th>
                    <th className="th">Agent name</th>
                    <th className="th">Dialing number</th>
                    <th className="th">Date &amp; time</th>
                    <th className="th">Connection status</th>
                    <th className="th">Connection details</th>
                    <th className="th">Duration</th>
                    <th className="th">Disposition</th>
                    <th className="th">Notes</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {!list.data?.calls.length ? (
                    <EmptyRow colSpan={11}>No calls match these filters.</EmptyRow>
                  ) : (
                    list.data.calls.map((c) => {
                      const hasRecording = !!(c.recording_path || c.recording_sid);
                      const hasTranscript = c.transcript_status === 'completed';
                      return (
                        <tr key={c.id} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpen(c.id)}>
                          <td className="td">
                            <p className="max-w-[200px] truncate font-medium">{c.full_name || '—'}</p>
                            <p className="text-xs tabular-nums text-ink-muted">{formatPhone(c.phone_e164)}</p>
                          </td>
                          <td className="td max-w-[180px] truncate text-ink-muted" title={c.campaign_name ?? undefined}>
                            {/* Calls made in JustCall before the dialer, imported with their recordings. */}
                            {c.source === 'justcall' && (
                              <span className="mr-1.5 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-ink-soft" title="Made in JustCall, before this dialer">
                                JustCall
                              </span>
                            )}
                            {c.campaign_name ?? '—'}
                          </td>
                          <td className="td whitespace-nowrap">{c.agent_name ?? <span className="text-ink-faint">—</span>}</td>
                          <td className="td whitespace-nowrap tabular-nums text-ink-muted">{c.from_number ? formatPhone(c.from_number) : '—'}</td>
                          <td className="td whitespace-nowrap tabular-nums text-ink-soft">{formatDateTime(c.started_at, { withZone: true })}</td>
                          <td className="td">
                            {c.pickup_status ? (
                              CONNECTED.includes(c.pickup_status) ? (
                                <Badge tone="green">Connected</Badge>
                              ) : (
                                <Badge tone="red">Not connected</Badge>
                              )
                            ) : (
                              <span className="text-ink-faint">—</span>
                            )}
                          </td>
                          <td className="td">{c.pickup_status ? <Badge tone={PICKUP_TONES[c.pickup_status] ?? 'grey'}>{c.pickup_status}</Badge> : <span className="text-ink-faint">—</span>}</td>
                          <td className="td tabular-nums text-ink-muted">{formatDuration(c.duration_s)}</td>
                          <td className="td">{c.disposition ? <Badge tone={DISPOSITION_TONES[c.disposition] ?? 'grey'}>{c.disposition}</Badge> : <span className="text-ink-faint">—</span>}</td>
                          <td className="td max-w-[200px] truncate text-ink-soft" title={c.notes ?? undefined}>
                            {c.notes || <span className="text-ink-faint">—</span>}
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-1.5">
                              <span
                                className={`flex h-8 w-8 items-center justify-center rounded-lg border ${hasRecording ? 'border-line-strong text-ink' : 'border-line text-ink-faint opacity-50'}`}
                                title={hasRecording ? 'Recording' : 'No recording'}
                              >
                                <Play size={14} />
                              </span>
                              <span
                                className={`flex h-8 w-8 items-center justify-center rounded-lg border ${hasTranscript ? 'border-line-strong text-ink' : 'border-line text-ink-faint opacity-50'}`}
                                title={hasTranscript ? 'Transcript' : 'No transcript'}
                              >
                                <FileText size={14} />
                              </span>
                              <ShareButton callId={c.id} disabled={!hasRecording} />
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <ServerPagination page={page} perPage={PER_PAGE} total={list.data?.total ?? 0} setPage={setPage} noun="calls" />
          </>
        )}
      </section>

      {open && <CallDetailModal callId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Copies a permanent, no-login link to the call's recording (/r/{id}.mp3), e.g. to send to a client. */
function ShareButton({ callId, disabled }: { callId: string; disabled: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || state === 'busy') return;
    setState('busy');
    try {
      const { url } = await api<{ url: string }>('call-share', { method: 'POST', body: JSON.stringify({ id: callId }) });
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      title={disabled ? 'No recording to share' : state === 'copied' ? 'Link copied' : state === 'error' ? "Couldn't copy the link" : 'Copy a link to the recording (plays without a login)'}
      aria-label="Copy recording link"
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${disabled ? 'border-line text-ink-faint opacity-50' : state === 'error' ? 'border-red-300 text-red-600' : 'border-line-strong text-ink hover:border-brand hover:text-brand'}`}
    >
      {state === 'copied' ? <Check size={14} className="text-emerald-600" /> : <Link2 size={14} />}
    </button>
  );
}

