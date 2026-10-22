import { ArrowRight, PhoneOutgoing } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Campaign, CampaignStats } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { Badge } from '../components/ui/Badge';
import { ErrorState, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { percent } from '../lib/format';
import { supabase } from '../lib/supabase';

export default function Campaigns() {
  const { isAdmin } = useAuth();
  const { data, error, loading, reload } = useLoad(async () => {
    const [campaigns, stats] = await Promise.all([
      supabase.from('campaigns').select('*').neq('status', 'archived').order('created_at', { ascending: false }),
      supabase.from('campaign_stats').select('*'),
    ]);
    const byId = new Map((must(stats) as CampaignStats[]).map((s) => [s.campaign_id, s]));
    return (must(campaigns) as Campaign[]).map((c) => ({ campaign: c, stats: byId.get(c.id) }));
  }, []);

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle={isAdmin ? 'Every active campaign. Assign people in Manage campaigns.' : 'The call lists assigned to you.'}
        actions={
          isAdmin && (
            <Link to="/admin/campaigns" className="inline-flex h-10 items-center rounded-full border border-line-border bg-white/70 px-5 text-[15px] font-medium hover:border-brand hover:text-brand">
              Manage campaigns
            </Link>
          )
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading ? (
        <div className="grid gap-5 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="card h-48 p-6">
              <div className="skeleton h-6 w-1/2" />
              <div className="skeleton mt-3 h-4 w-1/3" />
            </div>
          ))}
        </div>
      ) : !data?.length ? (
        <div className="card p-10 text-center text-ink-muted">
          {isAdmin ? 'No campaigns yet. Create one in Manage campaigns.' : "You're not assigned to any campaigns yet. Ask an admin to add you."}
        </div>
      ) : (
        <div className="grid animate-appear gap-5 md:grid-cols-2">
          {data.map(({ campaign: c, stats: s }) => (
            <div key={c.id} className="card flex flex-col p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link to={`/campaigns/${c.id}`} className="font-display text-xl font-medium hover:text-brand">
                    {c.name}
                  </Link>
                  <p className="mt-0.5 text-sm text-ink-muted">{c.client_name}</p>
                </div>
                {c.status === 'paused' && <Badge tone="amber">Paused</Badge>}
              </div>

              <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
                <Stat label="Left to call" value={s?.contacts_remaining ?? 0} sub={`of ${s?.contacts_total ?? 0}`} />
                <Stat label="Dials today" value={s?.dials_today ?? 0} />
                <Stat label="Connect rate" value={percent(s?.connects_total ?? 0, s?.dials_total ?? 0)} sub={`${s?.connects_total ?? 0} connects`} />
              </dl>

              <div className="mt-6 flex items-center gap-2">
                <Link
                  to={`/campaigns/${c.id}/dial`}
                  aria-disabled={c.status !== 'active'}
                  className={`inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-brand px-5 text-[15px] font-medium text-white transition hover:bg-brand-hover hover:shadow-btn ${c.status !== 'active' ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <PhoneOutgoing size={16} /> Start dialing
                </Link>
                <Link to={`/campaigns/${c.id}`} className="inline-flex h-10 items-center gap-1 rounded-full px-4 text-[15px] font-medium text-ink-muted hover:bg-black/[0.04] hover:text-ink">
                  Contacts <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl bg-neutral-50 px-2 py-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 font-display text-2xl font-medium tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</dd>
      {sub && <dd className="text-[11px] text-ink-faint">{sub}</dd>}
    </div>
  );
}
