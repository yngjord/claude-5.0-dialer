import { ArrowRight, PhoneOutgoing } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CallStatsRow, Campaign, CampaignStats } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { Badge } from '../components/ui/Badge';
import { Metric } from '../components/ui/Metric';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { defaultRange, rangeBounds, type DateRange } from '../lib/dateRange';
import { formatTalkTime, percent } from '../lib/format';
import { supabase } from '../lib/supabase';

export default function Campaigns() {
  const { isAdmin } = useAuth();
  const { data, error, loading, reload } = useLoad(async () => {
    const [campaigns, stats] = await Promise.all([
      supabase.from('dialer_campaigns').select('*').neq('status', 'archived').order('created_at', { ascending: false }),
      supabase.from('dialer_campaign_stats').select('*'),
    ]);
    const byId = new Map((must(stats) as CampaignStats[]).map((s) => [s.campaign_id, s]));
    return (must(campaigns) as Campaign[]).map((c) => ({ campaign: c, stats: byId.get(c.id) }));
  }, []);

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle={isAdmin ? "The team's numbers and every active campaign." : 'Your numbers and the call lists assigned to you.'}
        actions={
          isAdmin && (
            <Link to="/admin/campaigns" className="inline-flex h-10 items-center rounded-full border border-line-border bg-white/70 px-5 text-[15px] font-medium hover:border-brand hover:text-brand">
              Manage campaigns
            </Link>
          )
        }
      />

      <CallMetrics campaigns={data?.map((d) => d.campaign) ?? []} />

      <h2 className="mb-3 mt-8 animate-appear font-display text-lg font-medium">{isAdmin ? 'Campaigns' : 'Your campaigns'}</h2>
      <section className="card animate-appear p-4 sm:p-6">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingRows label="Loading campaigns…" />
        ) : (
          <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Campaign</th>
                  <th className="th">Client</th>
                  <th className="th text-right">Left to call</th>
                  <th className="th text-right">Dials today</th>
                  <th className="th text-right">Connect rate</th>
                  <th className="th" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!data?.length ? (
                  <EmptyRow colSpan={6}>
                    {isAdmin ? 'No campaigns yet. Create one in Manage campaigns.' : "You're not assigned to any campaigns yet. Ask an admin to add you."}
                  </EmptyRow>
                ) : (
                  data.map(({ campaign: c, stats: s }) => (
                    <tr key={c.id} className="transition-colors hover:bg-neutral-50">
                      <td className="td">
                        <span className="inline-flex items-center gap-2">
                          <Link to={`/campaigns/${c.id}`} className="font-medium hover:text-brand">
                            {c.name}
                          </Link>
                          {c.status === 'paused' && <Badge tone="amber">Paused</Badge>}
                        </span>
                      </td>
                      <td className="td text-ink-muted">{c.client_name}</td>
                      <td className="td text-right tabular-nums">
                        {(s?.contacts_remaining ?? 0).toLocaleString()} <span className="text-ink-faint">/ {(s?.contacts_total ?? 0).toLocaleString()}</span>
                      </td>
                      <td className="td text-right tabular-nums">{(s?.dials_today ?? 0).toLocaleString()}</td>
                      <td className="td text-right tabular-nums">{percent(s?.connects_total ?? 0, s?.dials_total ?? 0)}</td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-1">
                          <Link to={`/campaigns/${c.id}`} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium text-ink-muted hover:bg-black/[0.04] hover:text-ink">
                            Contacts <ArrowRight size={14} />
                          </Link>
                          <Link
                            to={`/campaigns/${c.id}/dial`}
                            aria-disabled={c.status !== 'active'}
                            className={`inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-sm font-medium text-white transition hover:bg-brand-hover ${c.status !== 'active' ? 'pointer-events-none opacity-50' : ''}`}
                          >
                            <PhoneOutgoing size={15} /> Dial
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Dials, connects, connect rate, appointments, follow-ups and talk time for a date range and campaign. Reps only
 * ever count their own calls (RLS on dialer_calls), and the campaign list only holds campaigns they're assigned to.
 */
function CallMetrics({ campaigns }: { campaigns: Pick<Campaign, 'id' | 'name'>[] }) {
  const [range, setRange] = useState<DateRange>(() => defaultRange('7'));
  const [campaignId, setCampaignId] = useState('');
  const bounds = rangeBounds(range);
  const stats = useLoad(
    async () =>
      must(
        await supabase.rpc('dialer_call_stats', {
          p_from: bounds.from ?? '2000-01-01T00:00:00Z',
          p_to: bounds.to ?? new Date(Date.now() + 60_000).toISOString(),
          p_campaign_id: campaignId || null,
        }),
      ) as CallStatsRow[],
    [bounds.from, bounds.to, campaignId],
  );

  const t = useMemo(
    () =>
      (stats.data ?? []).reduce(
        (sum, r) => ({
          dials: sum.dials + r.dials,
          connects: sum.connects + r.connects,
          appointments: sum.appointments + r.appointments,
          followUps: sum.followUps + r.follow_ups,
          talk: sum.talk + r.talk_seconds,
        }),
        { dials: 0, connects: 0, appointments: 0, followUps: 0, talk: 0 },
      ),
    [stats.data],
  );

  const loading = stats.loading;
  return (
    <section className="animate-appear">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} presets={['today', '7', '30', '90', 'custom']} />
        <select aria-label="Campaign" className="field !w-auto !rounded-full !py-2 text-sm" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {stats.error ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label="Dials" value={t.dials.toLocaleString()} loading={loading} />
          <Metric label="Connects" value={t.connects.toLocaleString()} loading={loading} />
          <Metric label="Connect rate" value={percent(t.connects, t.dials)} loading={loading} />
          <Metric label="Appointments" value={t.appointments.toLocaleString()} loading={loading} />
          <Metric label="Follow-ups" value={t.followUps.toLocaleString()} loading={loading} />
          <Metric label="Talk time" value={formatTalkTime(t.talk)} loading={loading} />
        </div>
      )}
    </section>
  );
}
