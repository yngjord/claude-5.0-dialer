import { AlertTriangle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AiInsightsStatus } from '../../shared/aiInsights';
import { api, apiQuiet, must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES } from '../lib/tones';
import { CallDetailModal } from './CallDetail';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

interface ReviewedCall {
  call_id: string;
  summary: string;
  call: { full_name: string | null; company: string | null; started_at: string; disposition: string | null; agent_name: string | null };
}

const SHOWN = 8;

/**
 * Admins only (the page doesn't render it for reps, and the database won't return reviews to them either). Runs the
 * AI analysis over the campaign's human pickups that haven't been reviewed, shows its progress, and lists the reviews.
 */
export function AiInsightsPanel({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState<AiInsightsStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const reviews = useLoad(async () => {
    const rows = must(
      await supabase
        .from('dialer_ai_call_insights')
        .select('call_id, summary, call:dialer_calls!inner(full_name, company, started_at, disposition, agent_name, campaign_id)')
        .eq('call.campaign_id', campaignId),
    ) as unknown as ReviewedCall[];
    return rows.sort((a, b) => b.call.started_at.localeCompare(a.call.started_at));
  }, [campaignId]);

  const loadStatus = async () => {
    try {
      setStatus(await apiQuiet<AiInsightsStatus>(`admin/ai-insights?campaignId=${encodeURIComponent(campaignId)}`));
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Could not load the AI analysis status.');
    }
  };
  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  // While a run is going: progress every 4 seconds, and the new reviews as they land.
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      loadStatus();
      reviews.reload({ quiet: true });
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  // When it finishes, one last refresh of the list.
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (wasRunning && !running) reviews.reload({ quiet: true });
    setWasRunning(running);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api('admin/ai-insights', { method: 'POST', body: JSON.stringify({ campaignId }) });
      await loadStatus();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the analysis.');
    } finally {
      setStarting(false);
    }
  };

  const blocked = useMemo(() => {
    if (!status) return null;
    if (!status.configured) return 'The Claude API key isn’t set up on this site yet (ANTHROPIC_API_KEY in Netlify).';
    if (!status.contextReady) return `Upload ${status.clientName}’s context in MaronlyOS first. The analysis uses it to judge each call.`;
    return null;
  }, [status]);

  const run = status?.lastRun;
  const list = reviews.data ?? [];
  const shown = showAll ? list : list.slice(0, SHOWN);

  return (
    <section className="card mb-6 animate-appear p-4 sm:mb-8 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-display text-lg font-medium">
            <Sparkles size={18} className="text-brand" /> AI call insights <Badge tone="grey">Admins only</Badge>
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {status
              ? [
                  `${status.analysed} conversation${status.analysed === 1 ? '' : 's'} analysed`,
                  status.toAnalyse ? `${status.toAnalyse} new to analyse` : 'none new to analyse',
                  status.awaitingTranscript ? `${status.awaitingTranscript} still being transcribed` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : statusError ?? 'Loading…'}
          </p>
        </div>
        <Button onClick={start} disabled={!status || running || starting || !!blocked || !status.toAnalyse} className="shrink-0">
          {running || starting ? <Spinner /> : <Sparkles size={15} />}
          {running ? 'Analysing…' : status?.toAnalyse ? `Analyse ${status.toAnalyse} new conversation${status.toAnalyse === 1 ? '' : 's'}` : 'Analyse new conversations'}
        </Button>
      </div>

      {blocked && <p className="mt-4 rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand">{blocked}</p>}

      {running && run && (
        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${run.total ? Math.round(((run.done + run.failed) / run.total) * 100) : 0}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            {run.done + run.failed} of {run.total} done. This keeps going if you leave the page.
          </p>
        </div>
      )}

      {(startError || (!running && run?.error)) && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {startError ?? run?.error}
        </p>
      )}

      {list.length > 0 && (
        <ul className="mt-5 divide-y divide-black/5">
          {shown.map((r) => (
            <li key={r.call_id}>
              <button onClick={() => setOpen(r.call_id)} className="w-full py-3 text-left transition hover:bg-black/[0.02]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium">{r.call.full_name ?? 'Unknown'}</span>
                  {r.call.company && <span className="text-ink-muted">{r.call.company}</span>}
                  <span className="text-ink-faint">
                    · {formatDateTime(r.call.started_at)}
                    {r.call.agent_name ? ` · ${r.call.agent_name}` : ''}
                  </span>
                  {r.call.disposition && <Badge tone={DISPOSITION_TONES[r.call.disposition] ?? 'grey'}>{r.call.disposition}</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{r.summary}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > SHOWN && (
        <button onClick={() => setShowAll((s) => !s)} className="mt-2 text-sm text-brand hover:underline">
          {showAll ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}

      {open && <CallDetailModal callId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
