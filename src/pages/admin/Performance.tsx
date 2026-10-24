import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Campaign, DialerUser } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { ClientLogo } from '../../components/ClientLogo';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { Metric } from '../../components/ui/Metric';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { Tabs } from '../../components/ui/Tabs';
import { must, useLoad } from '../../lib/api';
import { useAvatarUrls } from '../../lib/avatars';
import { useClientLogos } from '../../lib/clientLogos';
import { defaultRange, rangeBounds, type DateRange } from '../../lib/dateRange';
import { formatDateTime, formatTalkTime, percent } from '../../lib/format';
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

type View = 'team' | 'client';
type Totals = Omit<PerfRow, 'user_id' | 'agent_name' | 'client_name'>;
type Line = Totals & { key: string; name: string; userId: string | null; clientName: string | null };
type SortKey = 'name' | 'dials' | 'connects' | 'rate' | 'appointments' | 'follow_ups' | 'talk_seconds' | 'last_call_at';

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

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'dials', label: 'Dials', numeric: true },
  { key: 'connects', label: 'Connects', numeric: true },
  { key: 'rate', label: 'Connect rate', numeric: true },
  { key: 'appointments', label: 'Appointments', numeric: true },
  { key: 'follow_ups', label: 'Follow-ups', numeric: true },
  { key: 'talk_seconds', label: 'Talk time', numeric: true },
  { key: 'last_call_at', label: 'Last call' },
];

const sortValue = (l: Line, key: SortKey): string | number => (key === 'name' ? l.name.toLowerCase() : key === 'rate' ? (l.dials ? l.connects / l.dials : -1) : (l[key] ?? ''));

/**
 * Admin-only: how each team member and each client is performing over a date range, optionally narrowed to one
 * client or campaign. Counts dialer calls only (not the JustCall history), like the Campaigns metrics.
 */
export default function Performance() {
  const [range, setRange] = useState<DateRange>(() => defaultRange('month'));
  const bounds = rangeBounds(range);
  const [view, setView] = useState<View>('team');
  const [clientName, setClientName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'dials', desc: true });

  const campaigns = useLoad(
    async () => must(await supabase.from('dialer_campaigns').select('id, name, client_name, airtable_client_id').order('name')) as Pick<Campaign, 'id' | 'name' | 'client_name' | 'airtable_client_id'>[],
    [],
  );
  const users = useLoad(async () => must(await supabase.rpc('dialer_users')) as DialerUser[], []);
  const avatars = useAvatarUrls(users.data);
  const logos = useClientLogos();

  const stats = useLoad(
    async () =>
      must(
        await supabase.rpc('dialer_performance_stats', {
          p_from: bounds.from ?? '2000-01-01T00:00:00Z',
          p_to: bounds.to ?? new Date(Date.now() + 60_000).toISOString(),
          p_client_name: clientName || null,
          p_campaign_id: campaignId || null,
        }),
      ) as PerfRow[],
    [bounds.from, bounds.to, clientName, campaignId],
  );

  const clients = useMemo(() => [...new Set((campaigns.data ?? []).map((c) => c.client_name))].sort((a, b) => a.localeCompare(b)), [campaigns.data]);
  const clientIds = useMemo(() => new Map((campaigns.data ?? []).map((c) => [c.client_name, c.airtable_client_id])), [campaigns.data]);
  const campaignOptions = (campaigns.data ?? []).filter((c) => !clientName || c.client_name === clientName);

  const total = useMemo(() => (stats.data ?? []).reduce<Totals>((sum, r) => add(sum, r), EMPTY), [stats.data]);
  const lines = useMemo(() => {
    const byKey = new Map<string, Line>();
    for (const r of stats.data ?? []) {
      const key = view === 'team' ? (r.user_id ?? 'unknown') : (r.client_name ?? 'unknown');
      const user = users.data?.find((u) => u.id === r.user_id);
      const name = view === 'team' ? user?.display_name || r.agent_name || user?.email || 'Unknown' : r.client_name || 'No client';
      const prev = byKey.get(key);
      byKey.set(key, { ...(prev ?? { key, name, userId: r.user_id, clientName: r.client_name }), ...add(prev ?? EMPTY, r) });
    }
    const dir = sort.desc ? -1 : 1;
    return [...byKey.values()].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return x < y ? -dir : x > y ? dir : a.name.localeCompare(b.name);
    });
  }, [stats.data, users.data, view, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));
  const select = 'field !w-auto !rounded-full !py-2 text-sm';
  const loading = stats.loading;

  return (
    <>
      <PageHeader title="Performance" subtitle="How each team member and client is tracking. Dialer calls only, not the JustCall history." />

      <div className="mb-5 flex animate-appear flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} presets={['month', 'lastMonth', 'today', '7', '30', '90', 'all', 'custom']} />
        <select
          aria-label="Client"
          className={select}
          value={clientName}
          onChange={(e) => {
            setClientName(e.target.value);
            setCampaignId('');
          }}
        >
          <option value="">All clients</option>
          {clients.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select aria-label="Campaign" className={select} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All campaigns</option>
          {campaignOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {stats.error ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : (
        <>
          <div className="grid animate-appear grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <Metric label="Dials" value={total.dials.toLocaleString()} loading={loading} />
            <Metric label="Connects" value={total.connects.toLocaleString()} loading={loading} />
            <Metric label="Connect rate" value={percent(total.connects, total.dials)} loading={loading} />
            <Metric label="Appointments" value={total.appointments.toLocaleString()} loading={loading} />
            <Metric label="Follow-ups" value={total.follow_ups.toLocaleString()} loading={loading} />
            <Metric label="Talk time" value={formatTalkTime(total.talk_seconds)} loading={loading} />
          </div>

          <div className="mb-3 mt-8 flex animate-appear flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-medium">{view === 'team' ? 'By team member' : 'By client'}</h2>
            <Tabs
              label="Group by"
              tabs={[
                { value: 'team', label: 'Team members' },
                { value: 'client', label: 'Clients' },
              ]}
              value={view}
              onChange={(v) => {
                setView(v);
                setSort((s) => (s.key === 'name' ? s : { key: 'dials', desc: true }));
              }}
            />
          </div>

          <section className="card animate-appear p-4 sm:p-6">
            {loading && !stats.data ? (
              <LoadingRows label="Loading performance…" />
            ) : (
              <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[900px]">
                  <thead className="border-b border-line">
                    <tr>
                      <SortHeader label={view === 'team' ? 'Team member' : 'Client'} col="name" sort={sort} onSort={toggleSort} />
                      {COLUMNS.map((c) => (
                        <SortHeader key={c.key} label={c.label} col={c.key} sort={sort} onSort={toggleSort} right={c.numeric} />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {!lines.length ? (
                      <EmptyRow colSpan={8}>No calls in this period.</EmptyRow>
                    ) : (
                      lines.map((l) => (
                        <tr key={l.key}>
                          <td className="td">
                            <span className="flex items-center gap-3">
                              {view === 'team' ? (
                                <Avatar url={l.userId ? avatars.get(l.userId) : undefined} name={l.name} />
                              ) : (
                                <ClientLogo name={l.name} url={l.clientName ? logos[clientIds.get(l.clientName) ?? ''] : undefined} />
                              )}
                              {(view === 'team' || (l.clientName && logos[clientIds.get(l.clientName) ?? ''])) && <span className="font-medium">{l.name}</span>}
                            </span>
                          </td>
                          <Cells line={l} />
                        </tr>
                      ))
                    )}
                  </tbody>
                  {lines.length > 1 && (
                    <tfoot className="border-t-2 border-line font-medium">
                      <tr>
                        <td className="td">Total</td>
                        <Cells line={{ ...total, key: 'total', name: 'Total', userId: null, clientName: null }} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Cells({ line: l }: { line: Line }) {
  return (
    <>
      <td className="td text-right tabular-nums">{l.dials.toLocaleString()}</td>
      <td className="td text-right tabular-nums">{l.connects.toLocaleString()}</td>
      <td className="td text-right tabular-nums">{percent(l.connects, l.dials)}</td>
      <td className="td text-right tabular-nums">{l.appointments.toLocaleString()}</td>
      <td className="td text-right tabular-nums">{l.follow_ups.toLocaleString()}</td>
      <td className="td text-right tabular-nums">{formatTalkTime(l.talk_seconds)}</td>
      <td className="td whitespace-nowrap tabular-nums text-ink-muted">{formatDateTime(l.last_call_at)}</td>
    </>
  );
}

function SortHeader({ label, col, sort, onSort, right }: { label: string; col: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (k: SortKey) => void; right?: boolean }) {
  const active = sort.key === col;
  return (
    <th className={`th ${right ? 'text-right' : ''}`} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button onClick={() => onSort(col)} className={`inline-flex items-center gap-1 hover:text-ink ${active ? 'text-ink' : ''}`}>
        {label}
        {active && (sort.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
      </button>
    </th>
  );
}
