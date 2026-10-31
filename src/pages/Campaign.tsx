import { ArrowLeft, PhoneOutgoing, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatPhone } from '../../shared/phone';
import type { Campaign, CampaignStats, Contact } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { ImportModal } from '../components/ImportModal';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Metric } from '../components/ui/Metric';
import { SearchInput } from '../components/ui/SearchInput';
import { ServerPagination } from '../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { Tabs } from '../components/ui/Tabs';
import { must, useLoad } from '../lib/api';
import { formatDateTime, percent } from '../lib/format';
import { supabase } from '../lib/supabase';
import { CAMPAIGN_STATUS, CONTACT_STATUS_LABELS, DISPOSITION_TONES } from '../lib/tones';

const PER_PAGE = 50;
type Filter = 'all' | 'queue' | 'done' | 'removed';
// Removed contacts (do not call, bad number) are admin-only; team members' "All" leaves them out.
const FILTERS: Record<Filter, string[] | null> = { all: null, queue: ['new', 'callback'], done: ['done'], removed: ['do_not_call', 'bad_number'] };

export default function CampaignPage() {
  const { isAdmin } = useAuth();
  const { id = '' } = useParams();
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(0), [debounced, filter]);

  const head = useLoad(async () => {
    const [c, s] = await Promise.all([
      supabase.from('dialer_campaigns').select('*').eq('id', id).maybeSingle(),
      supabase.from('dialer_campaign_stats').select('*').eq('campaign_id', id).maybeSingle(),
    ]);
    return { campaign: must(c) as Campaign | null, stats: must(s) as CampaignStats | null };
  }, [id]);

  const list = useLoad(async () => {
    let q = supabase.from('dialer_contacts').select('*', { count: 'exact' }).eq('campaign_id', id);
    const statuses = FILTERS[filter];
    if (statuses) q = q.in('status', statuses);
    else if (!isAdmin) q = q.not('status', 'in', `(${FILTERS.removed!.join(',')})`);
    if (debounced) {
      const term = debounced.replace(/[%,()]/g, ' ');
      const digits = term.replace(/\D/g, '');
      q = q.or(
        [`full_name.ilike.%${term}%`, `company.ilike.%${term}%`, `email.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits.replace(/^0/, '')}%`] : [])].join(','),
      );
    }
    const res = await q.order('created_at').range(page * PER_PAGE, page * PER_PAGE + PER_PAGE - 1);
    return { contacts: must(res) as Contact[], total: res.count ?? 0 };
  }, [id, filter, debounced, page, isAdmin]);

  const campaign = head.data?.campaign;
  const stats = head.data?.stats;
  if (head.error) return <ErrorState message={head.error} onRetry={head.reload} />;
  if (!head.loading && !campaign) return <ErrorState message="Campaign not found, or you're not assigned to it." />;
  if (campaign?.status === 'paused' && !isAdmin) return <ErrorState message="This campaign is paused. It'll open again once an admin resumes it." />;

  const total = list.data?.total ?? 0;

  return (
    <>
      <Link to="/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-brand">
        <ArrowLeft size={15} /> Campaigns
      </Link>
      <PageHeader
        title={campaign?.name ?? 'Campaign'}
        subtitle={campaign ? `${campaign.client_name}${campaign.status !== 'active' ? ` · ${CAMPAIGN_STATUS[campaign.status].label}` : ''}` : undefined}
        actions={
          <>
            {isAdmin && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload size={16} /> Import CSV
              </Button>
            )}
            <Link
              to={`/campaigns/${id}/dial`}
              className={`inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-[15px] font-medium text-white transition hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-btn ${campaign?.status !== 'active' ? 'pointer-events-none opacity-50' : ''}`}
            >
              <PhoneOutgoing size={16} /> Start dialing
            </Link>
          </>
        }
      />

      <div className="mb-6 grid animate-appear grid-cols-2 gap-4 sm:mb-8 lg:grid-cols-5">
        <Metric
          label="Completed"
          value={((stats?.contacts_total ?? 0) - (stats?.contacts_remaining ?? 0)).toLocaleString()}
          note={`of ${(stats?.contacts_total ?? 0).toLocaleString()} contacts`}
          loading={head.loading}
        />
        <Metric label="Dials today" value={(stats?.dials_today ?? 0).toLocaleString()} note={`${stats?.connects_today ?? 0} connected`} loading={head.loading} />
        <Metric label="Total dials" value={(stats?.dials_total ?? 0).toLocaleString()} loading={head.loading} />
        <Metric label="Connect rate" value={percent(stats?.connects_total ?? 0, stats?.dials_total ?? 0)} note="Human pickups ÷ dials" loading={head.loading} />
        <Metric
          label="Booking rate"
          value={percent(stats?.appointments_total ?? 0, stats?.dials_total ?? 0)}
          loading={head.loading}
        />
      </div>

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            label="Contact status"
            value={filter}
            onChange={setFilter}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'queue', label: 'To call' },
              { value: 'done', label: 'Done' },
              ...(isAdmin ? [{ value: 'removed' as const, label: 'Removed' }] : []),
            ]}
          />
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, company, phone" />
        </div>

        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <LoadingRows label="Loading contacts…" />
        ) : (
          <>
            <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[900px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Contact</th>
                    <th className="th">Company</th>
                    <th className="th">Phone</th>
                    <th className="th">Status</th>
                    <th className="th">Dials</th>
                    <th className="th">Last outcome</th>
                    <th className="th">Last called</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {!list.data?.contacts.length ? (
                    <EmptyRow colSpan={7}>{debounced || filter !== 'all' ? 'No contacts match.' : isAdmin ? 'No contacts yet. Import a CSV to get started.' : 'No contacts yet.'}</EmptyRow>
                  ) : (
                    list.data.contacts.map((c) => (
                      <tr key={c.id} className="transition-colors hover:bg-neutral-50">
                        <td className="td">
                          <p className="font-medium">{c.full_name || '—'}</p>
                          {c.title && <p className="max-w-[220px] truncate text-xs text-ink-muted">{c.title}</p>}
                        </td>
                        <td className="td max-w-[200px] truncate">{c.company || <span className="text-ink-faint">—</span>}</td>
                        <td className="td tabular-nums">{formatPhone(c.phone_e164)}</td>
                        <td className="td">
                          <Badge tone={CONTACT_STATUS_LABELS[c.status]?.tone ?? 'grey'}>{CONTACT_STATUS_LABELS[c.status]?.label ?? c.status}</Badge>
                        </td>
                        <td className="td tabular-nums">{c.attempts}</td>
                        <td className="td">{c.last_disposition ? <Badge tone={DISPOSITION_TONES[c.last_disposition] ?? 'grey'}>{c.last_disposition}</Badge> : <span className="text-ink-faint">—</span>}</td>
                        <td className="td tabular-nums text-ink-muted">{formatDateTime(c.last_called_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <ServerPagination page={page} perPage={PER_PAGE} total={total} setPage={setPage} noun="contacts" />
          </>
        )}
      </section>

      {importing && (
        <ImportModal
          campaignId={id}
          onClose={() => setImporting(false)}
          onImported={() => {
            head.reload({ quiet: true });
            list.reload({ quiet: true });
          }}
        />
      )}
    </>
  );
}
