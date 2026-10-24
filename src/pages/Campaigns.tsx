import { ArrowRight, Check, Info, Pencil, PhoneOutgoing, Plus, RotateCcw, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CallStatsRow, Campaign, CampaignStats, DialerUser, PhoneNumber } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { ClientLogo } from '../components/ClientLogo';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Metric } from '../components/ui/Metric';
import { Tabs } from '../components/ui/Tabs';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { useAvatarUrls } from '../lib/avatars';
import type { CampaignRow } from '../lib/campaigns';
import { defaultRange, rangeBounds, type DateRange } from '../lib/dateRange';
import { formatTalkTime, percent } from '../lib/format';
import { useClientLogos } from '../lib/clientLogos';
import { supabase } from '../lib/supabase';
import { CAMPAIGN_STATUS } from '../lib/tones';
import { CampaignForm, MembersModal, RerunModal } from './admin/CampaignModals';

type Tab = 'active' | 'completed' | 'draft';

// Paused campaigns sit with the active ones (team members can see them but not open them). Drafts are admin-only.
const TAB_STATUSES: Record<Tab, Campaign['status'][]> = { active: ['active', 'paused'], completed: ['completed'], draft: ['draft'] };

export default function Campaigns() {
  const { isAdmin } = useAuth();
  const logos = useClientLogos();
  const [tab, setTab] = useState<Tab>('active');
  const { data, error, loading, reload } = useLoad(async () => {
    const [campaigns, stats] = await Promise.all([
      supabase.from('dialer_campaigns').select('*, campaign_members:dialer_campaign_members(user_id)').order('created_at', { ascending: false }),
      supabase.from('dialer_campaign_stats').select('*'),
    ]);
    const byId = new Map((must(stats) as CampaignStats[]).map((s) => [s.campaign_id, s]));
    return (must(campaigns) as CampaignRow[]).map((c) => ({ campaign: c, stats: byId.get(c.id) }));
  }, []);

  // Admin tools: create/edit, team member, re-run.
  const [editing, setEditing] = useState<CampaignRow | 'new' | null>(null);
  const [members, setMembers] = useState<CampaignRow | null>(null);
  const [rerun, setRerun] = useState<Campaign | null>(null);
  const users = useLoad(async () => (isAdmin ? (must(await supabase.rpc('dialer_users')) as DialerUser[]) : []), [isAdmin]);
  const numbers = useLoad(async () => (isAdmin ? (must(await supabase.from('dialer_phone_numbers').select('*').order('e164')) as PhoneNumber[]) : []), [isAdmin]);
  const avatars = useAvatarUrls(users.data);
  const nameOf = (id: string) => {
    const u = users.data?.find((x) => x.id === id);
    return u?.display_name || u?.email || 'Unknown';
  };
  const saved = () => {
    setEditing(null);
    setMembers(null);
    reload({ quiet: true });
  };

  const count = (t: Tab) => data?.filter((d) => TAB_STATUSES[t].includes(d.campaign.status)).length ?? 0;
  const shown = data?.filter((d) => TAB_STATUSES[tab].includes(d.campaign.status)) ?? [];
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'active', label: 'Active', count: data ? count('active') : undefined },
    { value: 'completed', label: 'Completed', count: data ? count('completed') : undefined },
    ...(isAdmin ? [{ value: 'draft' as const, label: 'Drafts', count: data ? count('draft') : undefined }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle={isAdmin ? 'Your numbers, and every campaign. Team-wide numbers are in Performance.' : 'Your numbers and the call lists assigned to you.'}
        actions={
          isAdmin && (
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} /> Create campaign
            </Button>
          )
        }
      />

      <CallMetrics campaigns={data?.map((d) => d.campaign) ?? []} />

      <div className="mb-3 mt-8 flex animate-appear flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-medium">{isAdmin ? 'Campaigns' : 'Your campaigns'}</h2>
        <Tabs label="Campaign status" tabs={tabs} value={tab} onChange={setTab} />
      </div>
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
                  <th className="th">Client</th>
                  <th className="th">Campaign</th>
                  <th className="th">
                    <span className="inline-flex items-center gap-1.5" title="Contacts that have been called and wrapped up, out of everyone in the campaign">
                      Completed / Total contacts <Info size={14} className="text-ink-faint" />
                    </span>
                  </th>
                  {isAdmin && <th className="th">Team</th>}
                  <th className="th text-right">Dials today</th>
                  <th className="th text-right">Connect rate</th>
                  <th className="th" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!shown.length ? (
                  <EmptyRow colSpan={isAdmin ? 7 : 6}>
                    {tab === 'completed'
                      ? 'No completed campaigns yet.'
                      : tab === 'draft'
                        ? 'No drafts. Use Create campaign and save it as a draft.'
                        : isAdmin
                          ? 'No active campaigns. Use Create campaign to add one.'
                          : "You aren't assigned any campaigns yet."}
                  </EmptyRow>
                ) : (
                  shown.map(({ campaign: c, stats: s }) => {
                    const total = s?.contacts_total ?? 0;
                    const completed = total - (s?.contacts_remaining ?? 0);
                    const done = c.status === 'completed' || (total > 0 && completed === total);
                    // Team members can't open paused campaigns; admins can open anything.
                    const openable = isAdmin || c.status !== 'paused';
                    return (
                      <tr key={c.id} className="transition-colors hover:bg-neutral-50">
                        <td className="td">
                          <ClientLogo name={c.client_name} url={logos[c.airtable_client_id]} />
                        </td>
                        <td className="td">
                          <span className="inline-flex items-center gap-2">
                            {openable ? (
                              <Link to={`/campaigns/${c.id}`} className="font-medium hover:text-brand">
                                {c.name}
                              </Link>
                            ) : (
                              <span className="font-medium text-ink-muted">{c.name}</span>
                            )}
                            {c.status !== 'active' && c.status !== 'completed' && <Badge tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Badge>}
                          </span>
                        </td>
                        <td className="td w-[240px]">
                          <p className="text-sm tabular-nums text-ink-muted">
                            {completed.toLocaleString()} / {total.toLocaleString()}
                          </p>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                              <div className={`h-full rounded-full transition-[width] ${done ? 'bg-emerald-500' : 'bg-brand'}`} style={{ width: `${done ? 100 : total ? (completed / total) * 100 : 0}%` }} />
                            </div>
                            {done && (
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white" title="Completed">
                                <Check size={11} strokeWidth={3} />
                              </span>
                            )}
                          </div>
                        </td>
                        {isAdmin && (
                          <td className="td">
                            <button
                              onClick={() => setMembers(c)}
                              className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
                              title={c.campaign_members.map((m) => nameOf(m.user_id)).join(', ') || 'Assign a team member'}
                            >
                              {c.campaign_members.length ? (
                                <span className="flex -space-x-2">
                                  {c.campaign_members.map((m) => (
                                    <Avatar key={m.user_id} url={avatars.get(m.user_id)} name={nameOf(m.user_id)} />
                                  ))}
                                </span>
                              ) : (
                                <>
                                  <Users size={15} /> Assign
                                </>
                              )}
                            </button>
                          </td>
                        )}
                        <td className="td text-right tabular-nums">{(s?.dials_today ?? 0).toLocaleString()}</td>
                        <td className="td text-right tabular-nums">{percent(s?.connects_total ?? 0, s?.dials_total ?? 0)}</td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-1">
                            {isAdmin && (
                              <>
                                <button onClick={() => setEditing(c)} className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-black/[0.04] hover:text-ink" title="Edit campaign" aria-label={`Edit ${c.name}`}>
                                  <Pencil size={15} />
                                </button>
                                <button onClick={() => setRerun(c)} className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-black/[0.04] hover:text-ink" title="Re-run: new campaign from contacts already called" aria-label={`Re-run ${c.name}`}>
                                  <RotateCcw size={15} />
                                </button>
                              </>
                            )}
                            {openable ? (
                              <Link to={`/campaigns/${c.id}`} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium text-ink-muted hover:bg-black/[0.04] hover:text-ink">
                                Contacts <ArrowRight size={14} />
                              </Link>
                            ) : (
                              <span className="px-3 text-sm text-ink-faint">Paused</span>
                            )}
                            {c.status !== 'completed' && (
                              <Link
                                to={`/campaigns/${c.id}/dial`}
                                aria-disabled={c.status !== 'active'}
                                className={`inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-sm font-medium text-white transition hover:bg-brand-hover ${c.status !== 'active' ? 'pointer-events-none opacity-50' : ''}`}
                              >
                                <PhoneOutgoing size={15} /> Dial
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && <CampaignForm campaign={editing === 'new' ? null : editing} numbers={numbers.data ?? []} users={users.data ?? []} onClose={() => setEditing(null)} onSaved={saved} />}
      {rerun && <RerunModal campaign={rerun} onClose={() => setRerun(null)} onCreated={() => reload({ quiet: true })} />}
      {members && (
        <MembersModal campaign={members} users={users.data ?? []} avatars={avatars} onPhotosChanged={() => users.reload({ quiet: true })} onClose={() => setMembers(null)} onSaved={saved} />
      )}
    </>
  );
}

/**
 * Dials, connects, connect rate, appointments, leads and talk time for a date range, client and campaign: always the
 * logged-in user's own calls, admins included (dialer_call_stats). The team-wide view is the admin Performance page.
 */
function CallMetrics({ campaigns }: { campaigns: Pick<Campaign, 'id' | 'name' | 'client_name'>[] }) {
  const [range, setRange] = useState<DateRange>(() => defaultRange('month'));
  const [clientName, setClientName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  // Split by client only when the user has campaigns for more than one.
  const clients = [...new Set(campaigns.map((c) => c.client_name))].sort((a, b) => a.localeCompare(b));
  const campaignOptions = clientName ? campaigns.filter((c) => c.client_name === clientName) : campaigns;
  const bounds = rangeBounds(range);
  const stats = useLoad(
    async () =>
      must(
        await supabase.rpc('dialer_call_stats', {
          p_from: bounds.from ?? '2000-01-01T00:00:00Z',
          p_to: bounds.to ?? new Date(Date.now() + 60_000).toISOString(),
          p_campaign_id: campaignId || null,
          p_client_name: clientName || null,
        }),
      ) as CallStatsRow[],
    [bounds.from, bounds.to, campaignId, clientName],
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
        <DateRangeFilter value={range} onChange={setRange} presets={['today', 'month', '7', '30', '90', 'custom']} />
        {clients.length > 1 && (
          <select
            aria-label="Client"
            className="field !w-auto !rounded-full !py-2 text-sm"
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
        )}
        <select aria-label="Campaign" className="field !w-auto !rounded-full !py-2 text-sm" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label="Dials" value={t.dials.toLocaleString()} loading={loading} />
          <Metric label="Connects" value={t.connects.toLocaleString()} loading={loading} />
          <Metric label="Connect rate" value={percent(t.connects, t.dials)} loading={loading} />
          <Metric label="Appointments" value={t.appointments.toLocaleString()} loading={loading} />
          <Metric label="Leads" value={t.followUps.toLocaleString()} loading={loading} />
          <Metric label="Talk time" value={formatTalkTime(t.talk)} loading={loading} />
        </div>
      )}
    </section>
  );
}
