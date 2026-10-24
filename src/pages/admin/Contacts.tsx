import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DISPOSITIONS } from '../../../shared/constants';
import { formatPhone } from '../../../shared/phone';
import type { Campaign, Contact } from '../../../shared/types';
import { ClientLogo } from '../../components/ClientLogo';
import { Badge } from '../../components/ui/Badge';
import { SearchInput } from '../../components/ui/SearchInput';
import { ServerPagination } from '../../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { must, useLoad } from '../../lib/api';
import { useClientLogos } from '../../lib/clientLogos';
import { formatDateTime } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { CONTACT_STATUS_LABELS, DISPOSITION_TONES } from '../../lib/tones';

const PER_PAGE = 50;

// "Called" goes by attempts (any wrapped-up call); the rest are contact statuses.
const STATUS_FILTERS = {
  '': 'Any status',
  not_called: 'Not called yet',
  called: 'Called',
  queue: 'To call (in the queue)',
  callback: 'Callback booked',
  done: 'Done',
  removed: 'Do not call / bad number',
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

type Row = Contact & { campaign: Pick<Campaign, 'name'> | null };

/** Admin-only: every contact across campaigns and clients, with the same columns as a campaign's contact list. */
export default function Contacts() {
  const logos = useClientLogos();
  const [clientName, setClientName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [disposition, setDisposition] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(0), [clientName, campaignId, status, disposition, debounced]);

  const campaigns = useLoad(
    async () => must(await supabase.from('dialer_campaigns').select('id, name, client_name, airtable_client_id').order('name')) as Pick<Campaign, 'id' | 'name' | 'client_name' | 'airtable_client_id'>[],
    [],
  );
  const clients = useMemo(() => [...new Set((campaigns.data ?? []).map((c) => c.client_name))].sort((a, b) => a.localeCompare(b)), [campaigns.data]);
  const campaignOptions = (campaigns.data ?? []).filter((c) => !clientName || c.client_name === clientName);

  const list = useLoad(async () => {
    let q = supabase.from('dialer_contacts').select('*, campaign:dialer_campaigns(name)', { count: 'exact' });
    if (clientName) q = q.eq('client_name', clientName);
    if (campaignId) q = q.eq('campaign_id', campaignId);
    if (disposition) q = q.eq('last_disposition', disposition);
    if (status === 'not_called') q = q.eq('attempts', 0);
    else if (status === 'called') q = q.gt('attempts', 0);
    else if (status === 'queue') q = q.in('status', ['new', 'callback']);
    else if (status === 'callback') q = q.eq('status', 'callback');
    else if (status === 'done') q = q.eq('status', 'done');
    else if (status === 'removed') q = q.in('status', ['do_not_call', 'bad_number']);
    if (debounced) {
      const term = debounced.replace(/[%,()]/g, ' ');
      const digits = term.replace(/\D/g, '');
      q = q.or(
        [`full_name.ilike.%${term}%`, `company.ilike.%${term}%`, `email.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits.replace(/^0/, '')}%`] : [])].join(','),
      );
    }
    const res = await q.order('created_at', { ascending: false }).range(page * PER_PAGE, page * PER_PAGE + PER_PAGE - 1);
    return { contacts: must(res) as Row[], total: res.count ?? 0 };
  }, [clientName, campaignId, status, disposition, debounced, page]);

  const select = 'field !w-auto !rounded-full !py-2 text-sm';

  return (
    <>
      <PageHeader title="Contacts" subtitle="Every contact across all campaigns and clients." />

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
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
            <select aria-label="Status" className={select} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {Object.entries(STATUS_FILTERS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select aria-label="Last disposition" className={select} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
              <option value="">Any disposition</option>
              {DISPOSITIONS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, company, email, phone" />
        </div>

        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <LoadingRows label="Loading contacts…" />
        ) : (
          <>
            <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[1040px]">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">Contact</th>
                    <th className="th">Client</th>
                    <th className="th">Campaign</th>
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
                    <EmptyRow colSpan={9}>No contacts match these filters.</EmptyRow>
                  ) : (
                    list.data.contacts.map((c) => (
                      <tr key={c.id} className="transition-colors hover:bg-neutral-50">
                        <td className="td">
                          <p className="max-w-[200px] truncate font-medium">{c.full_name || '—'}</p>
                          {c.title && <p className="max-w-[200px] truncate text-xs text-ink-muted">{c.title}</p>}
                        </td>
                        <td className="td">{c.client_name ? <ClientLogo name={c.client_name} url={logos[c.airtable_client_id ?? '']} /> : <span className="text-ink-faint">—</span>}</td>
                        <td className="td max-w-[180px] truncate">
                          <Link to={`/campaigns/${c.campaign_id}`} className="text-ink-muted hover:text-brand" title={c.campaign?.name}>
                            {c.campaign?.name ?? '—'}
                          </Link>
                        </td>
                        <td className="td max-w-[180px] truncate">{c.company || <span className="text-ink-faint">—</span>}</td>
                        <td className="td whitespace-nowrap tabular-nums">{formatPhone(c.phone_e164)}</td>
                        <td className="td">
                          <Badge tone={CONTACT_STATUS_LABELS[c.status]?.tone ?? 'grey'}>{CONTACT_STATUS_LABELS[c.status]?.label ?? c.status}</Badge>
                        </td>
                        <td className="td tabular-nums">{c.attempts}</td>
                        <td className="td">{c.last_disposition ? <Badge tone={DISPOSITION_TONES[c.last_disposition] ?? 'grey'}>{c.last_disposition}</Badge> : <span className="text-ink-faint">—</span>}</td>
                        <td className="td whitespace-nowrap tabular-nums text-ink-muted">{formatDateTime(c.last_called_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <ServerPagination page={page} perPage={PER_PAGE} total={list.data?.total ?? 0} setPage={setPage} noun="contacts" />
          </>
        )}
      </section>
    </>
  );
}
