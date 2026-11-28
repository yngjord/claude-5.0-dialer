import { Building2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, must, useLoad } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

interface Coverage {
  contacts: number;
  contacts_with_company: number;
  companies: number;
  summarised: number;
  no_data: number;
  labelling: number;
  sized: number;
  complete: number;
  headcount_lookable: number;
  headcount_running: number;
  headcount_not_found: number;
}

/** Icypeas charges half a credit per company it finds. */
const CREDITS_PER_COMPANY = 0.5;

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

/**
 * Admins only (inside the AI insights panel). How complete the campaign's company data is: companies with both an AI
 * summary and a size bracket, what's missing, and a button that looks up the missing headcounts on LinkedIn
 * (Icypeas, paid, so only when asked). Summaries are made automatically when companies are added.
 */
export function CompanyCoverage({ campaignId }: { campaignId: string }) {
  const coverage = useLoad(async () => {
    const rows = must(await supabase.rpc('dialer_company_coverage', { p_campaign_id: campaignId })) as Coverage[];
    return rows[0] ?? null;
  }, [campaignId]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = coverage.data;

  // While headcounts are being looked up, refresh every 5 seconds (summaries show on the next visit).
  const busy = !!c && c.headcount_running > 0;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => coverage.reload({ quiet: true }), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const findHeadcounts = async () => {
    setStarting(true);
    setError(null);
    try {
      await api('companies', { method: 'POST', body: JSON.stringify({ action: 'headcount', campaignId }) });
      // The job marks companies as it takes them; give it a moment, then show it running.
      setTimeout(() => coverage.reload({ quiet: true }), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the headcount lookup.');
    } finally {
      setTimeout(() => setStarting(false), 2500);
    }
  };

  if (!c) return coverage.error ? <p className="mt-4 text-sm text-red-600">Company data: {coverage.error}</p> : null;
  const missingSize = c.companies - c.sized;
  const running = c.headcount_running > 0;
  const details = [
    `${plural(c.summarised, 'summary', 'summaries')} (${pct(c.summarised, c.companies)})`,
    `${plural(c.sized, 'size bracket')} (${pct(c.sized, c.companies)})`,
    c.labelling ? `${c.labelling.toLocaleString()} being summarised` : null,
    c.no_data ? `${c.no_data.toLocaleString()} with nothing to summarise` : null,
    c.headcount_not_found ? `${c.headcount_not_found.toLocaleString()} not on LinkedIn` : null,
    c.contacts - c.contacts_with_company ? `${plural(c.contacts - c.contacts_with_company, 'contact')} with no website or company LinkedIn` : null,
  ].filter(Boolean);

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl bg-neutral-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Building2 size={15} className="shrink-0 text-ink-muted" />
          Company data: {c.complete.toLocaleString()} of {plural(c.companies, 'company', 'companies')} complete ({pct(c.complete, c.companies)})
        </p>
        <p className="mt-0.5 text-ink-muted">{details.join(' · ')}</p>
        {error && <p className="mt-1 text-red-600">{error}</p>}
      </div>
      {(c.headcount_lookable > 0 || running) && (
        <Button variant="outline" onClick={findHeadcounts} disabled={running || starting} className="shrink-0" title="Looks up company size on LinkedIn through Icypeas">
          {running || starting ? <Spinner /> : null}
          {running
            ? `Finding headcounts… ${c.headcount_running.toLocaleString()} left`
            : `Find ${plural(c.headcount_lookable, 'headcount')} (≈${Math.ceil(c.headcount_lookable * CREDITS_PER_COMPANY).toLocaleString()} credits)`}
        </Button>
      )}
      {!c.headcount_lookable && !running && missingSize > 0 && <span className="shrink-0 text-sm text-ink-muted">{missingSize.toLocaleString()} without a size can’t be looked up</span>}
    </div>
  );
}
