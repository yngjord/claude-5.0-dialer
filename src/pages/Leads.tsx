import { ChevronDown, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MyLead } from '../../shared/types';
import { ClientLogo } from '../components/ClientLogo';
import { NewLeadModal } from '../components/NewLeadModal';
import { Badge, type Tone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../components/ui/States';
import { Tabs } from '../components/ui/Tabs';
import { api, useLoad } from '../lib/api';
import { sydneyToday } from '../lib/format';

type Period = 'last' | 'this' | 'all';

const STAGE_TONES: Record<string, Tone> = { Booking: 'green', Closed: 'greenSolid' };

/** YYYY-MM of an ISO timestamp, in Sydney time. */
const sydneyMonth = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }).slice(0, 7);
const formatDay = (date: string | null) => (date ? new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const formatOpened = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Australia/Sydney' });
const initials = (name: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

/**
 * The bookings the logged-in rep has made: Airtable Leads they created through the dialer (Booking or Closed),
 * by the month they were opened. Grouped by client when they've booked for more than one.
 */
export default function Leads() {
  const leads = useLoad(() => api<MyLead[]>('my-leads'), []);
  const [period, setPeriod] = useState<Period>('this');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const thisMonth = sydneyToday().slice(0, 7);
  const lastMonth = (() => {
    const [y, m] = thisMonth.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  })();
  const inPeriod = (l: MyLead, p: Period) => p === 'all' || sydneyMonth(l.opened) === (p === 'this' ? thisMonth : lastMonth);

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (leads.data ?? []).filter(
      (l) => inPeriod(l, period) && (!term || [l.fullName, l.email, l.phone, l.notes, l.clientName].some((v) => v?.toLowerCase().includes(term))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads.data, period, query, thisMonth]);

  // Group by client only when the rep has booked for more than one.
  const groups = useMemo(() => {
    const byClient = new Map<string, { name: string; logo: string | null; leads: MyLead[] }>();
    for (const l of shown) {
      const key = l.clientId ?? 'none';
      const g = byClient.get(key) ?? { name: l.clientName ?? 'No client', logo: l.clientLogo, leads: [] };
      g.leads.push(l);
      byClient.set(key, g);
    }
    return [...byClient.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [shown]);
  const allClients = new Set((leads.data ?? []).map((l) => l.clientId ?? 'none'));
  const grouped = allClients.size > 1;

  const count = (p: Period) => (leads.data ? leads.data.filter((l) => inPeriod(l, p)).length : undefined);

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Leads attributed to you: meetings booked on your calls, and leads that booked after we followed up."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} /> Add new lead
          </Button>
        }
      />

      <section className="card animate-appear p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            label="Period"
            value={period}
            onChange={setPeriod}
            tabs={[
              { value: 'last', label: 'Last month', count: count('last') },
              { value: 'this', label: 'This month', count: count('this') },
              { value: 'all', label: 'All time', count: count('all') },
            ]}
          />
          <SearchInput value={query} onChange={setQuery} placeholder="Search leads, notes" />
        </div>

        {leads.error ? (
          <ErrorState message={leads.error} onRetry={leads.reload} />
        ) : leads.loading ? (
          <LoadingRows label="Loading your leads…" />
        ) : !shown.length ? (
          <table className="w-full">
            <tbody>
              <EmptyRow colSpan={1}>
                {leads.data?.length ? 'No leads in this period.' : 'No booked leads yet. Leads you create with "Interested - Appointment Set" show here.'}
              </EmptyRow>
            </tbody>
          </table>
        ) : (
          <div className="space-y-6">
            {groups.map(([key, g]) => {
              const isCollapsed = grouped && collapsed.has(key);
              return (
                <div key={key}>
                  {grouped && (
                    <button
                      onClick={() =>
                        setCollapsed((s) => {
                          const next = new Set(s);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-expanded={!isCollapsed}
                      className="mb-2 flex items-center gap-3 rounded-full py-1 pr-2 text-left"
                    >
                      <ChevronDown size={18} className={`text-ink-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                      <ClientLogo name={g.name} url={g.logo ?? undefined} />
                      {g.logo && <span className="font-medium">{g.name}</span>}
                      <span className="tabular-nums text-ink-muted">{g.leads.length}</span>
                    </button>
                  )}
                  {!isCollapsed && (
                    <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                      {/* Fixed widths so the columns line up across client groups. */}
                      <table className="w-full min-w-[900px] table-fixed">
                        <colgroup>
                          <col className="w-[32%]" />
                          <col className="w-[11%]" />
                          <col className="w-[13%]" />
                          <col className="w-[11%]" />
                          <col />
                        </colgroup>
                        <thead className="border-b border-line">
                          <tr>
                            <th className="th">Lead</th>
                            <th className="th">Stage</th>
                            <th className="th">Booked for</th>
                            <th className="th">Opened</th>
                            <th className="th">Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {g.leads.map((l) => (
                            <tr key={l.id} className="align-top">
                              <td className="td">
                                <div className="flex items-start gap-3">
                                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-white text-sm text-ink-soft">
                                    {initials(l.fullName)}
                                    {l.linkedin && (
                                      <a
                                        href={/^https?:\/\//i.test(l.linkedin) ? l.linkedin : `https://${l.linkedin}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-md border border-line bg-white text-[9px] font-bold text-brand"
                                        aria-label={`${l.fullName ?? 'Lead'} on LinkedIn`}
                                      >
                                        in
                                      </a>
                                    )}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="truncate font-medium">{l.fullName || '—'}</p>
                                    {l.email && <p className="truncate text-sm text-ink-muted">{l.email}</p>}
                                    {l.phone && <p className="text-sm tabular-nums text-ink-muted">{l.phone}</p>}
                                  </div>
                                </div>
                              </td>
                              <td className="td">{l.stage ? <Badge tone={STAGE_TONES[l.stage] ?? 'grey'}>{l.stage}</Badge> : <span className="text-ink-faint">—</span>}</td>
                              <td className="td whitespace-nowrap tabular-nums">
                                {formatDay(l.bookedFor)}
                                {l.timeBookedFor && <p className="text-xs text-ink-muted">{l.timeBookedFor}</p>}
                              </td>
                              <td className="td whitespace-nowrap tabular-nums text-ink-muted">{formatOpened(l.opened)}</td>
                              <td className="td">
                                <p className="line-clamp-3 whitespace-pre-wrap text-ink-soft" title={l.notes ?? undefined}>
                                  {l.notes || <span className="text-ink-faint">No notes</span>}
                                </p>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {adding && (
        <NewLeadModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            leads.reload();
          }}
        />
      )}
    </>
  );
}
