import { useMemo, useState } from 'react';
import type { CallStatsRow, Campaign } from '../../shared/types';
import { Metric } from '../components/ui/Metric';
import { EmptyRow, ErrorState, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { formatTalkTime, percent, sydneyDayStart } from '../lib/format';
import { supabase } from '../lib/supabase';

const RANGES = { '1': 'Today', '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days' } as const;
type Range = keyof typeof RANGES;

interface Totals {
  dials: number;
  connects: number;
  machine: number;
  appointments: number;
  follow_ups: number;
  talk_seconds: number;
}
const empty = (): Totals => ({ dials: 0, connects: 0, machine: 0, appointments: 0, follow_ups: 0, talk_seconds: 0 });
function add(t: Totals, r: CallStatsRow) {
  t.dials += r.dials;
  t.connects += r.connects;
  t.machine += r.machine;
  t.appointments += r.appointments;
  t.follow_ups += r.follow_ups;
  t.talk_seconds += r.talk_seconds;
}

export default function Stats() {
  const [range, setRange] = useState<Range>('7');
  const [campaignId, setCampaignId] = useState('');
  const campaigns = useLoad(async () => must(await supabase.from('campaigns').select('id, name').order('name')) as Pick<Campaign, 'id' | 'name'>[], []);
  const stats = useLoad(
    async () =>
      must(
        await supabase.rpc('call_stats', {
          p_from: sydneyDayStart(Number(range) - 1),
          p_to: new Date(Date.now() + 60_000).toISOString(),
          p_campaign_id: campaignId || null,
        }),
      ) as CallStatsRow[],
    [range, campaignId],
  );

  const { total, byRep, byDay } = useMemo(() => {
    const total = empty();
    const reps = new Map<string, Totals & { name: string }>();
    const days = new Map<string, Totals>();
    for (const r of stats.data ?? []) {
      add(total, r);
      const key = r.user_id ?? 'unknown';
      const rep = reps.get(key) ?? { ...empty(), name: r.agent_name ?? 'Unknown' };
      add(rep, r);
      reps.set(key, rep);
      const day = days.get(r.day) ?? empty();
      add(day, r);
      days.set(r.day, day);
    }
    return {
      total,
      byRep: [...reps.values()].sort((a, b) => b.dials - a.dials),
      byDay: [...days.entries()].sort(([a], [b]) => b.localeCompare(a)),
    };
  }, [stats.data]);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';
  const loading = stats.loading;

  return (
    <>
      <PageHeader
        title="Stats"
        subtitle="Connect rate is human pickups ÷ dials, straight from Twilio's answering machine detection."
        actions={
          <>
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
          </>
        }
      />

      {stats.error ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : (
        <>
          <div className="mb-6 grid animate-appear grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-3 xl:grid-cols-6">
            <Metric label="Dials" value={total.dials.toLocaleString()} loading={loading} />
            <Metric label="Connects" value={total.connects.toLocaleString()} loading={loading} />
            <Metric label="Connect rate" value={percent(total.connects, total.dials)} loading={loading} />
            <Metric label="Appointments" value={total.appointments.toLocaleString()} loading={loading} />
            <Metric label="Follow-ups" value={total.follow_ups.toLocaleString()} loading={loading} />
            <Metric label="Talk time" value={formatTalkTime(total.talk_seconds)} loading={loading} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <StatsTable title="By rep" first="Rep" rows={byRep.map((r) => [r.name, r])} loading={loading} />
            <StatsTable
              title="By day"
              first="Day"
              rows={byDay.map(([day, t]) => [new Date(`${day}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }), t])}
              loading={loading}
            />
          </div>
        </>
      )}
    </>
  );
}

function StatsTable({ title, first, rows, loading }: { title: string; first: string; rows: [string, Totals][]; loading: boolean }) {
  return (
    <section className="card animate-appear p-4 sm:p-6">
      <h2 className="mb-4 font-display text-lg font-medium">{title}</h2>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[520px]">
          <thead className="border-b border-line">
            <tr>
              <th className="th">{first}</th>
              <th className="th text-right">Dials</th>
              <th className="th text-right">Connects</th>
              <th className="th text-right">Rate</th>
              <th className="th text-right">Appts</th>
              <th className="th text-right">Follow-ups</th>
              <th className="th text-right">Talk</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading ? (
              <EmptyRow colSpan={7}>Loading…</EmptyRow>
            ) : !rows.length ? (
              <EmptyRow colSpan={7}>No calls in this period.</EmptyRow>
            ) : (
              rows.map(([label, t]) => (
                <tr key={label}>
                  <td className="td font-medium">{label}</td>
                  <td className="td text-right tabular-nums">{t.dials}</td>
                  <td className="td text-right tabular-nums">{t.connects}</td>
                  <td className="td text-right tabular-nums">{percent(t.connects, t.dials)}</td>
                  <td className="td text-right tabular-nums">{t.appointments}</td>
                  <td className="td text-right tabular-nums">{t.follow_ups}</td>
                  <td className="td text-right tabular-nums">{formatTalkTime(t.talk_seconds)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
