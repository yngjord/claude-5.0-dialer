import { FileText, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { DISPOSITIONS, PICKUP_STATUSES, type PickupStatus } from '../../shared/constants';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { formatPhone } from '../../shared/phone';
import type { CallRow, Campaign } from '../../shared/types';
import { CallDetailModal } from '../components/CallDetail';
import { Badge } from '../components/ui/Badge';
import { SearchInput } from '../components/ui/SearchInput';
import { ServerPagination } from '../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
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
  const [disposition, setDisposition] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(0), [bounds.from, bounds.to, campaignId, pickup, disposition, debounced]);

  const campaigns = useLoad(async () => must(await supabase.from('dialer_campaigns').select('id, name').order('name')) as Pick<Campaign, 'id' | 'name'>[], []);

  const list = useLoad(async () => {
    let q = supabase
      .from('dialer_calls')
      .select('id, started_at, full_name, phone_e164, from_number, campaign_name, agent_name, pickup_status, disposition, notes, duration_s, recording_path, recording_sid, transcript_status', {
        count: 'exact',
      })
      .eq('direction', 'outbound');
    if (bounds.from) q = q.gte('started_at', bounds.from);
    if (bounds.to) q = q.lt('started_at', bounds.to);
    if (campaignId) q = q.eq('campaign_id', campaignId);
    if (pickup) q = q.eq('pickup_status', pickup);
    if (disposition) q = q.eq('disposition', disposition);
    if (debounced) {
      const term = debounced.replace(/[%,()]/g, ' ');
      const digits = term.replace(/\D/g, '');
      q = q.or([`full_name.ilike.%${term}%`, `company.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits.replace(/^0/, '')}%`] : [])].join(','));
    }
    const res = await q.order('started_at', { ascending: false }).range(page * PER_PAGE, page * PER_PAGE + PER_PAGE - 1);
    return { calls: must(res) as CallRow[], total: res.count ?? 0 };
  }, [bounds.from, bounds.to, campaignId, pickup, disposition, debounced, page]);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';

  return (
    <>
      <PageHeader title="Call logs" subtitle={isAdmin ? "Every call the team has made, with recordings and transcripts." : "Your calls, with recordings and transcripts."} />

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter value={range} onChange={setRange} presets={['today', 'month', '7', '30', '90', 'all', 'custom']} />
            <select aria-label="Campaign" className={select} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">All campaigns</option>
              {campaigns.data?.map((c) => (
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
            <select aria-label="Disposition" className={select} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
              <option value="">Any disposition</option>
              {DISPOSITIONS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, company, phone" />
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
                            {c.campaign_name ?? '—'}
                          </td>
                          <td className="td whitespace-nowrap">{c.agent_name ?? <span className="text-ink-faint">—</span>}</td>
                          <td className="td whitespace-nowrap tabular-nums text-ink-muted">{c.from_number ? formatPhone(c.from_number) : '—'}</td>
                          <td className="td whitespace-nowrap tabular-nums text-ink-soft">{formatDateTime(c.started_at)}</td>
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
