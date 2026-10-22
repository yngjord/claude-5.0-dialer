import { PlayCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DISPOSITIONS, PICKUP_STATUSES } from '../../shared/constants';
import { formatPhone } from '../../shared/phone';
import type { CallRow, Campaign } from '../../shared/types';
import { CallDetailModal } from '../components/CallDetail';
import { Badge } from '../components/ui/Badge';
import { SearchInput } from '../components/ui/SearchInput';
import { ServerPagination } from '../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration, sydneyDayStart } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES, PICKUP_TONES } from '../lib/tones';

const PER_PAGE = 50;
const RANGES = { today: 'Today', '7': 'Last 7 days', '30': 'Last 30 days', all: 'All time' } as const;
type Range = keyof typeof RANGES;

export default function Calls() {
  const [range, setRange] = useState<Range>('7');
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
  useEffect(() => setPage(0), [range, campaignId, pickup, disposition, debounced]);

  const campaigns = useLoad(async () => must(await supabase.from('dialer_campaigns').select('id, name').order('name')) as Pick<Campaign, 'id' | 'name'>[], []);

  const list = useLoad(async () => {
    let q = supabase
      .from('dialer_calls')
      .select('id, started_at, full_name, company, phone_e164, campaign_name, agent_name, pickup_status, disposition, duration_s, recording_path, recording_sid, source', { count: 'exact' })
      .eq('direction', 'outbound');
    if (range !== 'all') q = q.gte('started_at', sydneyDayStart(range === 'today' ? 0 : Number(range) - 1));
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
  }, [range, campaignId, pickup, disposition, debounced, page]);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';

  return (
    <>
      <PageHeader title="Calls" subtitle="Every dial, with recordings and transcripts of the conversations." />

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Date range" className={select} value={range} onChange={(e) => setRange(e.target.value as Range)}>
              {Object.entries(RANGES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
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
              <table className="w-full min-w-[960px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Contact</th>
                    <th className="th">Phone</th>
                    <th className="th">Campaign</th>
                    <th className="th">Agent</th>
                    <th className="th">Pickup</th>
                    <th className="th">Disposition</th>
                    <th className="th">Length</th>
                    <th className="th" aria-label="Recording" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {!list.data?.calls.length ? (
                    <EmptyRow colSpan={9}>No calls match these filters.</EmptyRow>
                  ) : (
                    list.data.calls.map((c) => (
                      <tr key={c.id} className="cursor-pointer transition-colors hover:bg-neutral-50" onClick={() => setOpen(c.id)}>
                        <td className="td tabular-nums text-ink-soft">{formatDateTime(c.started_at)}</td>
                        <td className="td">
                          <p className="font-medium">{c.full_name || '—'}</p>
                          {c.company && <p className="max-w-[200px] truncate text-xs text-ink-muted">{c.company}</p>}
                        </td>
                        <td className="td tabular-nums">{formatPhone(c.phone_e164)}</td>
                        <td className="td max-w-[170px] truncate text-ink-muted" title={c.campaign_name ?? undefined}>
                          {c.campaign_name ?? '—'}
                        </td>
                        <td className="td">{c.agent_name ?? <span className="text-ink-faint">—</span>}</td>
                        <td className="td">{c.pickup_status ? <Badge tone={PICKUP_TONES[c.pickup_status] ?? 'grey'}>{c.pickup_status}</Badge> : <span className="text-ink-faint">—</span>}</td>
                        <td className="td">{c.disposition ? <Badge tone={DISPOSITION_TONES[c.disposition] ?? 'grey'}>{c.disposition}</Badge> : <span className="text-ink-faint">—</span>}</td>
                        <td className="td tabular-nums text-ink-muted">{formatDuration(c.duration_s)}</td>
                        <td className="td">
                          {(c.recording_path || c.recording_sid) && (
                            <span className="inline-flex items-center gap-1.5 text-brand">
                              <PlayCircle size={16} /> Listen
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
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
