import { ArrowRight, PhoneOutgoing } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Campaign, CampaignStats } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { Badge } from '../components/ui/Badge';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { must, useLoad } from '../lib/api';
import { percent } from '../lib/format';
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
        subtitle={isAdmin ? 'Every active campaign. Assign people in Manage campaigns.' : 'The call lists assigned to you.'}
        actions={
          isAdmin && (
            <Link to="/admin/campaigns" className="inline-flex h-10 items-center rounded-full border border-line-border bg-white/70 px-5 text-[15px] font-medium hover:border-brand hover:text-brand">
              Manage campaigns
            </Link>
          )
        }
      />

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
