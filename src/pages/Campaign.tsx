import { ArrowLeft, PhoneOutgoing, RotateCcw, SkipForward, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatPhone } from '../../shared/phone';
import type { Campaign, CampaignStats, Contact, DialerUser } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { AiInsightsPanel } from '../components/AiInsightsPanel';
import { ImportModal } from '../components/ImportModal';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Metric } from '../components/ui/Metric';
import { Spinner } from '../components/ui/Spinner';
import { SearchInput } from '../components/ui/SearchInput';
import { ServerPagination } from '../components/ui/ServerPagination';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { Tabs } from '../components/ui/Tabs';
import { must, useLoad } from '../lib/api';
import { completion } from '../lib/completion';
import { formatDateTime, percent } from '../lib/format';
import { supabase } from '../lib/supabase';
import { CAMPAIGN_STATUS, CONTACT_STATUS_LABELS, DISPOSITION_TONES } from '../lib/tones';

const PER_PAGE = 50;
type Filter = 'all' | 'queue' | 'done' | 'skipped' | 'removed';
// Removed contacts (do not call, bad number) are admin-only; team members' "All" leaves them out.
const FILTERS: Record<Filter, string[] | null> = { all: null, queue: ['new', 'callback'], done: ['done'], skipped: ['skipped'], removed: ['do_not_call', 'bad_number'] };
/** A contact a rep claimed this recently may be on their screen or on a live call, so bulk delete leaves it alone. */
const LOCK_MINUTES = 30;

/** The campaign's contacts matching the tab and search (the same set the table pages through). */
function contactsQuery(campaignId: string, columns: string, filter: Filter, search: string, isAdmin: boolean, count = false) {
  let q = supabase.from('dialer_contacts').select(columns, count ? { count: 'exact' } : undefined).eq('campaign_id', campaignId);
  const statuses = FILTERS[filter];
  if (statuses) q = q.in('status', statuses);
  else if (!isAdmin) q = q.not('status', 'in', `(${FILTERS.removed!.join(',')})`);
  if (search) {
    const term = search.replace(/[%,()]/g, ' ');
    const digits = term.replace(/\D/g, '');
    q = q.or(
      [`full_name.ilike.%${term}%`, `company.ilike.%${term}%`, `email.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits.replace(/^0/, '')}%`] : [])].join(','),
    );
  }
  return q;
}

type Held = { ids: string[]; who: string };

/**
 * Deletes these contacts (admins only, by RLS). Their calls stay in the call log. Unless `force`, a contact another
 * person has had open in the dialer in the last half hour is left alone and reported back, so it can't vanish from
 * under a live call; your own open ones are fine to delete.
 */
async function deleteContacts(ids: string[], force = false): Promise<{ deleted: number; held: Held | null }> {
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  const myId = (await supabase.auth.getSession()).data.session?.user.id ?? '';
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 100) {
    let q = supabase.from('dialer_contacts').delete().in('id', ids.slice(i, i + 100));
    if (!force) q = q.or(`locked_by.is.null,locked_at.lt."${since}"${myId ? `,locked_by.eq.${myId}` : ''}`);
    deleted += (must(await q.select('id')) as { id: string }[]).length;
  }
  if (force || deleted === ids.length) return { deleted, held: null };

  // What's left, and who has it open.
  const left: { id: string; locked_by: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    left.push(...(must(await supabase.from('dialer_contacts').select('id, locked_by').in('id', ids.slice(i, i + 100))) as typeof left));
  }
  if (!left.length) return { deleted, held: null };
  const users = must(await supabase.rpc('dialer_users')) as DialerUser[];
  const names = [...new Set(left.map((c) => users.find((u) => u.id === c.locked_by)).map((u) => u?.display_name || u?.email || 'a rep'))];
  return { deleted, held: { ids: left.map((c) => c.id), who: names.join(', ') } };
}

/**
 * Admins: marks these contacts skipped (only ones still to call: new or callback; called ones keep their outcome),
 * or puts skipped ones back in the queue. Returns how many changed.
 */
async function setSkipped(ids: string[], skip: boolean): Promise<number> {
  const myId = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  const values = skip ? { status: 'skipped', skipped_at: new Date().toISOString(), skipped_by: myId } : { status: 'new', skipped_at: null, skipped_by: null };
  let changed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const q = supabase.from('dialer_contacts').update(values).in('id', ids.slice(i, i + 100)).in('status', skip ? ['new', 'callback'] : ['skipped']);
    changed += (must(await q.select('id')) as { id: string }[]).length;
  }
  return changed;
}

export default function CampaignPage() {
  const { isAdmin } = useAuth();
  const { id = '' } = useParams();
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  // Admin bulk delete: ticked rows (kept across pages), or every contact matching the tab and search.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; held?: Held } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPage(0), [debounced, filter]);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [debounced, filter, id]);

  const head = useLoad(async () => {
    const [c, s] = await Promise.all([
      supabase.from('dialer_campaigns').select('*').eq('id', id).maybeSingle(),
      supabase.from('dialer_campaign_stats').select('*').eq('campaign_id', id).maybeSingle(),
    ]);
    return { campaign: must(c) as Campaign | null, stats: must(s) as CampaignStats | null };
  }, [id]);

  const list = useLoad(async () => {
    const res = await contactsQuery(id, '*', filter, debounced, isAdmin, true)
      .order('created_at')
      .range(page * PER_PAGE, page * PER_PAGE + PER_PAGE - 1);
    return { contacts: must(res) as unknown as Contact[], total: res.count ?? 0 };
  }, [id, filter, debounced, page, isAdmin]);

  const pageIds = (list.data?.contacts ?? []).map((c) => c.id);
  const pageAllSelected = allMatching || (pageIds.length > 0 && pageIds.every((cid) => selected.has(cid)));
  const pageSomeSelected = !pageAllSelected && pageIds.some((cid) => selected.has(cid));
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = pageSomeSelected;
  }, [pageSomeSelected]);

  const togglePage = () => {
    setNotice(null);
    if (pageAllSelected) {
      setAllMatching(false);
      setSelected((s) => new Set([...s].filter((cid) => !pageIds.includes(cid))));
    } else setSelected((s) => new Set([...s, ...pageIds]));
  };
  const toggleOne = (cid: string) => {
    setNotice(null);
    if (allMatching) {
      // Un-ticking one row out of "all matching" keeps the rest of this page ticked.
      setAllMatching(false);
      setSelected(new Set(pageIds.filter((x) => x !== cid)));
      return;
    }
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  const finishDelete = async ({ deleted, held }: { deleted: number; held: Held | null }) => {
    const k = held?.ids.length ?? 0;
    setNotice({
      ok: true,
      text: `Deleted ${deleted.toLocaleString()} contact${deleted === 1 ? '' : 's'}.${
        held ? ` ${k.toLocaleString()} skipped: ${held.who} ${k === 1 ? 'has it' : 'has them'} open in the dialer.` : ''
      }`,
      held: held ?? undefined,
    });
    if (page > 0 && deleted >= pageIds.length) setPage(0);
    head.reload({ quiet: true });
    list.reload({ quiet: true });
  };

  const deleteHeldAnyway = async (held: Held) => {
    if (!window.confirm(`${held.who} may be on a call with ${held.ids.length === 1 ? 'this contact' : 'these contacts'} right now. Delete anyway?`)) return;
    setDeleting(true);
    try {
      await finishDelete(await deleteContacts(held.ids, true));
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Could not delete the contacts.' });
    } finally {
      setDeleting(false);
    }
  };

  /** The ticked contacts, or every one matching the tab and search. */
  const selectedIds = async () => {
    if (!allMatching) return [...selected];
    const ids: string[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = must(await contactsQuery(id, 'id', filter, debounced, isAdmin).order('created_at').range(from, from + 999)) as unknown as { id: string }[];
      ids.push(...rows.map((r) => r.id));
      if (rows.length < 1000) return ids;
    }
  };

  const skipSelected = async (skip: boolean) => {
    setDeleting(true);
    setNotice(null);
    try {
      const ids = await selectedIds();
      if (!ids.length) return;
      const changed = await setSkipped(ids, skip);
      const others = ids.length - changed;
      const s = (n: number) => (n === 1 ? '' : 's');
      setNotice({
        ok: true,
        text: skip
          ? `Marked ${changed.toLocaleString()} contact${s(changed)} as skipped.${others ? ` ${others.toLocaleString()} already called or skipped, left as they were.` : ''}`
          : `Put ${changed.toLocaleString()} skipped contact${s(changed)} back in the queue.${others ? ` ${others.toLocaleString()} weren't skipped, left as they were.` : ''}`,
      });
      clearSelection();
      head.reload({ quiet: true });
      list.reload({ quiet: true });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Could not update the contacts.' });
    } finally {
      setDeleting(false);
    }
  };

  const removeSelected = async () => {
    setDeleting(true);
    setNotice(null);
    try {
      const ids = await selectedIds();
      if (!ids.length) return;
      const n = ids.length.toLocaleString();
      if (!window.confirm(`Delete ${n} contact${ids.length === 1 ? '' : 's'} from this campaign?\n\nTheir past calls stay in Call logs. This can't be undone.`)) return;
      await finishDelete(await deleteContacts(ids));
      clearSelection();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Could not delete the contacts.' });
    } finally {
      setDeleting(false);
    }
  };

  const campaign = head.data?.campaign;
  const stats = head.data?.stats;
  if (head.error) return <ErrorState message={head.error} onRetry={head.reload} />;
  if (!head.loading && !campaign) return <ErrorState message="Campaign not found, or you're not assigned to it." />;
  if (campaign?.status === 'paused' && !isAdmin) return <ErrorState message="This campaign is paused. It'll open again once an admin resumes it." />;

  const total = list.data?.total ?? 0;
  const selectedCount = allMatching ? total : selected.size;
  const cols = isAdmin ? 8 : 7;

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
          value={completion(stats).dialled.toLocaleString()}
          note={`of ${(stats?.contacts_total ?? 0).toLocaleString()} contacts${stats?.contacts_skipped ? ` · ${stats.contacts_skipped.toLocaleString()} skipped` : ''}`}
          loading={head.loading}
        />
        <Metric label="Dials today" value={(stats?.dials_today ?? 0).toLocaleString()} note={`${stats?.connects_today ?? 0} connected`} loading={head.loading} />
        <Metric label="Total dials" value={(stats?.dials_total ?? 0).toLocaleString()} loading={head.loading} />
        <Metric label="Connect rate" value={percent(stats?.connects_total ?? 0, stats?.dials_total ?? 0)} note={`${(stats?.connects_total ?? 0).toLocaleString()} human pickup${stats?.connects_total === 1 ? '' : 's'}`} loading={head.loading} />
        <Metric
          label="Booking rate"
          value={percent(stats?.appointments_total ?? 0, stats?.dials_total ?? 0)}
          note={`${(stats?.appointments_total ?? 0).toLocaleString()} booking${stats?.appointments_total === 1 ? '' : 's'} made`}
          loading={head.loading}
        />
      </div>

      {/* AI insights are admin-only, always. */}
      {isAdmin && campaign && <AiInsightsPanel campaignId={campaign.id} />}

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
              ...(stats?.contacts_skipped ? [{ value: 'skipped' as const, label: 'Skipped' }] : []),
              ...(isAdmin ? [{ value: 'removed' as const, label: 'Removed' }] : []),
            ]}
          />
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, company, phone" />
        </div>

        {isAdmin && (selectedCount > 0 || notice) && (
          <div className="mb-4 space-y-2">
            {selectedCount > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-brand/5 px-4 py-2.5 text-sm">
                <span className="font-medium">
                  {selectedCount.toLocaleString()} selected{allMatching && (debounced || filter !== 'all') ? ' (all matching)' : allMatching ? ' (all in campaign)' : ''}
                </span>
                {!allMatching && pageAllSelected && total > pageIds.length && (
                  <button type="button" className="text-brand hover:underline" onClick={() => setAllMatching(true)}>
                    Select all {total.toLocaleString()} {debounced || filter !== 'all' ? 'matching contacts' : 'contacts in this campaign'}
                  </button>
                )}
                <button type="button" className="text-ink-muted hover:text-ink" onClick={clearSelection} disabled={deleting}>
                  Clear
                </button>
                {filter === 'skipped' ? (
                  <Button variant="outline" className="ml-auto !h-9" onClick={() => skipSelected(false)} disabled={deleting}>
                    <RotateCcw size={15} /> Back to queue
                  </Button>
                ) : (
                  <Button variant="outline" className="ml-auto !h-9 !border-amber-200 !text-amber-800 hover:!border-amber-400" onClick={() => skipSelected(true)} disabled={deleting}>
                    <SkipForward size={15} /> Mark as skipped
                  </Button>
                )}
                <Button variant="outline" className="!h-9 !border-red-200 !text-red-700 hover:!border-red-400" onClick={removeSelected} disabled={deleting}>
                  {deleting ? <Spinner /> : <Trash2 size={15} />} Delete
                </Button>
              </div>
            )}
            {notice && (
              <p role={notice.ok ? 'status' : 'alert'} className={`rounded-2xl px-4 py-2.5 text-sm ${notice.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
                {notice.text}
                {notice.held && (
                  <button type="button" className="ml-2 font-medium text-red-700 underline-offset-2 hover:underline" onClick={() => deleteHeldAnyway(notice.held!)} disabled={deleting}>
                    Delete anyway
                  </button>
                )}
              </p>
            )}
          </div>
        )}

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
                    {isAdmin && (
                      <th className="th w-10">
                        <input
                          ref={headerBox}
                          type="checkbox"
                          className="h-4 w-4 accent-brand"
                          checked={pageAllSelected}
                          onChange={togglePage}
                          disabled={!pageIds.length || deleting}
                          aria-label="Select all contacts on this page"
                        />
                      </th>
                    )}
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
                    <EmptyRow colSpan={cols}>{debounced || filter !== 'all' ? 'No contacts match.' : isAdmin ? 'No contacts yet. Import a CSV to get started.' : 'No contacts yet.'}</EmptyRow>
                  ) : (
                    list.data.contacts.map((c) => (
                      <tr key={c.id} className={`transition-colors ${allMatching || selected.has(c.id) ? 'bg-brand/5' : 'hover:bg-neutral-50'}`}>
                        {isAdmin && (
                          <td className="td w-10">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-brand"
                              checked={allMatching || selected.has(c.id)}
                              onChange={() => toggleOne(c.id)}
                              disabled={deleting}
                              aria-label={`Select ${c.full_name || formatPhone(c.phone_e164)}`}
                            />
                          </td>
                        )}
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
