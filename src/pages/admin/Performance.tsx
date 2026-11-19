import { useMemo, useState } from 'react';
import type { Campaign, DialerUser } from '../../../shared/types';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { PerformanceTrend } from '../../components/PerformanceTrend';
import { PickupTimes } from '../../components/PickupTimes';
import { Metric } from '../../components/ui/Metric';
import { ErrorState, PageHeader } from '../../components/ui/States';
import { must, useLoad } from '../../lib/api';
import { defaultRange, rangeBounds, type DateRange } from '../../lib/dateRange';
import { formatTalkTime, percent } from '../../lib/format';
import { supabase } from '../../lib/supabase';

interface PerfRow {
  user_id: string | null;
  agent_name: string | null;
  client_name: string | null;
  dials: number;
  connects: number;
  machine: number;
  unanswered: number;
  appointments: number;
  follow_ups: number;
  talk_seconds: number;
  last_call_at: string | null;
}

interface ActivityRow {
  user_id: string;
  dials: number;
  sessions: number;
  active_seconds: number;
}

type Totals = Omit<PerfRow, 'user_id' | 'agent_name' | 'client_name'>;

const EMPTY: Totals = { dials: 0, connects: 0, machine: 0, unanswered: 0, appointments: 0, follow_ups: 0, talk_seconds: 0, last_call_at: null };

function add(a: Totals, b: Totals): Totals {
  return {
    dials: a.dials + b.dials,
    connects: a.connects + b.connects,
    machine: a.machine + b.machine,
    unanswered: a.unanswered + b.unanswered,
    appointments: a.appointments + b.appointments,
    follow_ups: a.follow_ups + b.follow_ups,
    talk_seconds: a.talk_seconds + b.talk_seconds,
    last_call_at: !a.last_call_at || (b.last_call_at && b.last_call_at > a.last_call_at) ? b.last_call_at : a.last_call_at,
  };
}

/** Dials per hour of dialing time, or null when there's no dialing time to divide by. */
const callsPerHour = (dials: number, seconds: number | null) => (seconds ? dials / (seconds / 3600) : null);

/**
 * Admin-only: how the team is performing over a date range, optionally narrowed to one client and/or one team member
 * (a campaign's own page has its metrics): dials, outcomes, calls per hour, activity over time and the best times of
 * day to call. Counts calls made in the dialer, like the Campaigns metrics.
 */
export default function Performance() {
  const [range, setRange] = useState<DateRange>(() => defaultRange('month'));
  const bounds = rangeBounds(range);
  const from = bounds.from ?? '2000-01-01T00:00:00Z';
  const to = bounds.to ?? new Date(Date.now() + 60_000).toISOString();
  const [clientName, setClientName] = useState('');
  const [userId, setUserId] = useState('');

  const campaigns = useLoad(
    async () => must(await supabase.from('dialer_campaigns').select('client_name').eq('source', 'dialer')) as Pick<Campaign, 'client_name'>[],
    [],
  );
  const users = useLoad(async () => must(await supabase.rpc('dialer_users')) as DialerUser[], []);

  // Per rep and client; narrowed to the chosen team member below.
  const stats = useLoad(
    async () =>
      must(await supabase.rpc('dialer_performance_stats', { p_from: from, p_to: to, p_client_name: clientName || null, p_campaign_id: null })) as PerfRow[],
    [bounds.from, bounds.to, clientName],
  );

  // Each rep's dialing time, for calls per hour (sessions of calls; a 15+ minute gap starts a new one).
  const activity = useLoad(
    async () =>
      must(await supabase.rpc('dialer_rep_activity', { p_from: from, p_to: to, p_client_name: clientName || null, p_campaign_id: null })) as ActivityRow[],
    [bounds.from, bounds.to, clientName],
  );

  const clients = useMemo(() => [...new Set((campaigns.data ?? []).map((c) => c.client_name))].sort((a, b) => a.localeCompare(b)), [campaigns.data]);
  const team = useMemo(
    () =>
      (users.data ?? [])
        .filter((u) => u.role === 'team' || u.role === 'admin')
        .map((u) => ({ id: u.id, name: u.display_name || u.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users.data],
  );

  const total = useMemo(
    () => (stats.data ?? []).filter((r) => !userId || r.user_id === userId).reduce<Totals>((sum, r) => add(sum, r), EMPTY),
    [stats.data, userId],
  );
  const totalActive = (activity.data ?? []).filter((a) => !userId || a.user_id === userId).reduce((sum, a) => sum + a.active_seconds, 0);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';
  const loading = stats.loading;

  return (
    <>
      <PageHeader title="Performance" subtitle="How the team and each client is tracking." />

      <div className="mb-5 flex animate-appear flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} presets={['month', 'lastMonth', 'today', '7', '30', '90', 'all', 'custom']} />
        <select aria-label="Client" className={select} value={clientName} onChange={(e) => setClientName(e.target.value)}>
          <option value="">All clients</option>
          {clients.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select aria-label="Team member" className={select} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">All team members</option>
          {team.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      {stats.error ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : (
        <>
          <div className="grid animate-appear grid-cols-2 gap-4 lg:grid-cols-4">
            <Metric label="Dials" value={total.dials.toLocaleString()} loading={loading} />
            <Metric label="Connects" value={total.connects.toLocaleString()} loading={loading} />
            <Metric label="Connect rate" value={percent(total.connects, total.dials)} loading={loading} />
            <Metric label="Appointments" value={total.appointments.toLocaleString()} loading={loading} />
            <Metric label="Booking rate" value={percent(total.appointments, total.dials)} loading={loading} />
            <Metric label="Leads" value={total.follow_ups.toLocaleString()} loading={loading} />
            <Metric
              label="Talk time"
              value={formatTalkTime(total.talk_seconds)}
              note={activity.loading ? undefined : `${totalActive ? formatTalkTime(totalActive) : 'No'} dialing time`}
              loading={loading}
            />
            <Metric
              label="Calls/hr"
              value={callsPerHour(total.dials, totalActive)?.toFixed(1) ?? '—'}
              loading={loading || activity.loading}
            />
          </div>

          <PerformanceTrend range={range} from={from} to={to} clientName={clientName || null} userId={userId || null} />

          <section className="card mt-8 animate-appear p-4 sm:p-6">
            <PickupTimes from={from} to={to} clientName={clientName || null} userId={userId || null} />
          </section>
          <p className="mt-3 text-xs text-ink-muted">
            Calls/hr is dials ÷ dialing time. Dialing time runs from the first call to the end of the last in each session, plus a minute for the last
            wrap-up; a gap of more than 15 minutes between calls starts a new session, so breaks don't count.
          </p>
        </>
      )}
    </>
  );
}
