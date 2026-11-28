import { AlertTriangle, ChevronDown, ExternalLink, FileText, Sparkles, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AiInsightsStatus } from '../../shared/aiInsights';
import type { ClayLinkStatus } from '../../shared/clay';
import { api, apiQuiet, must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES } from '../lib/tones';
import { CallDetailModal } from './CallDetail';
import { CompanyCoverage } from './CompanyCoverage';
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
  // Collapsed by default to keep the campaign page calm: the header, progress and any problem stay visible.
  const [expanded, setExpanded] = useState(false);

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

  // Analysis needs the Claude key, the client's context and a checked Clay table; the steps below show which is missing.
  const blocked = useMemo(() => {
    if (!status) return null;
    if (!status.configured) return 'The Claude API key isn’t set up on this site yet (ANTHROPIC_API_KEY in Netlify).';
    return null;
  }, [status]);
  const ready = !!status && !blocked && status.contextReady && !!status.clay?.valid;

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
          {status && (
            <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className="mt-2 inline-flex items-center gap-1 text-sm text-brand hover:underline">
              <ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
              {expanded ? 'Hide details' : list.length ? `Show setup and ${list.length} review${list.length === 1 ? '' : 's'}` : 'Show setup'}
            </button>
          )}
        </div>
        <Button onClick={start} disabled={!status || running || starting || !ready || !status.toAnalyse} className="shrink-0">
          {running || starting ? <Spinner /> : <Sparkles size={15} />}
          {running ? 'Analysing…' : status?.toAnalyse ? `Analyse ${status.toAnalyse} new conversation${status.toAnalyse === 1 ? '' : 's'}` : 'Analyse new conversations'}
        </Button>
      </div>

      {/* What the AI insights will know about each company: summary and size. */}
      <CompanyCoverage campaignId={campaignId} />

      {blocked && <p className="mt-4 rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand">{blocked}</p>}

      {/* Setup stays visible while something is missing, so it's clear why analysis can't run. */}
      {status && (expanded || !ready) && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <Step done={status.contextReady} icon={<FileText size={16} />} title="Client context">
            {status.contextReady ? `${status.clientName}’s context from MaronlyOS is ready.` : `Upload ${status.clientName}’s context in MaronlyOS. The analysis uses it to judge each call.`}
          </Step>
          <ClayStep campaignId={campaignId} status={status} onChecked={(clay) => setStatus((s) => (s ? { ...s, clay } : s))} />
        </div>
      )}

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

      {expanded && list.length > 0 && (
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
      {expanded && list.length > SHOWN && (
        <button onClick={() => setShowAll((s) => !s)} className="mt-2 text-sm text-brand hover:underline">
          {showAll ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}

      {open && <CallDetailModal callId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** One setup step for analysis, ticked when done. */
function Step({ done, icon, title, children }: { done: boolean; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-2xl border p-4 ${done ? 'border-emerald-200 bg-emerald-50/50' : 'border-black/10 bg-neutral-50'}`}>
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full ${done ? 'bg-emerald-600 text-white' : 'bg-white text-ink-muted ring-1 ring-black/10'}`}>
          {done ? <Tick /> : icon}
        </span>
        {title}
      </p>
      <div className="mt-2 text-sm text-ink-soft">{children}</div>
    </div>
  );
}

/** A check mark that draws itself in. */
function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="animate-draw" />
    </svg>
  );
}

/**
 * The campaign's Clay table: paste its URL, and the dialer reads it through Clay's API and counts how many of the
 * campaign's contacts it finds. Analysis needs at least half of them found.
 */
function ClayStep({ campaignId, status, onChecked }: { campaignId: string; status: AiInsightsStatus; onChecked: (clay: ClayLinkStatus) => void }) {
  const clay = status.clay;
  const [editing, setEditing] = useState(!clay);
  const [url, setUrl] = useState(clay?.tableUrl ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);

  const check = async (tableUrl: string) => {
    setChecking(true);
    setError(null);
    setJustChecked(false);
    try {
      const result = await api<ClayLinkStatus>('admin/ai-insights/clay', { method: 'POST', body: JSON.stringify({ campaignId, url: tableUrl }) });
      onChecked(result);
      setEditing(false);
      setJustChecked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the table.');
    } finally {
      setChecking(false);
    }
  };

  const done = !!clay?.valid && !editing && !checking;
  return (
    <Step done={done} icon={<Table2 size={16} />} title="Clay table">
      {!status.clayConfigured ? (
        <p>The Clay API key isn’t set up on this site yet (CLAY_API_KEY in Netlify).</p>
      ) : checking ? (
        <div className="animate-fade-in">
          <p className="flex items-center gap-2">
            <Spinner /> Reading the table in Clay and finding this campaign’s contacts…
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/5">
            <div className="h-full w-1/3 animate-loading-bar rounded-full bg-brand" />
          </div>
        </div>
      ) : editing || !clay ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) check(url);
          }}
          className="space-y-2"
        >
          <p>Paste the URL of the Clay table this campaign’s leads came from. Several campaigns can share one table.</p>
          <div className="flex gap-2">
            <input
              aria-label="Clay table URL"
              className="field !py-2 text-sm"
              placeholder="https://app.clay.com/workspaces/…/tables/t_…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" disabled={!url.trim()} className="shrink-0">
              Check
            </Button>
          </div>
          {clay && (
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-ink-muted hover:underline">
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className={justChecked ? 'animate-appear' : undefined}>
          <p className={clay.valid ? 'text-emerald-800' : 'text-amber-800'}>
            {clay.valid ? 'Found ' : 'Only found '}
            <span className="font-medium tabular-nums">
              {clay.contactsMatched.toLocaleString()} of {clay.contactsTotal.toLocaleString()}
            </span>{' '}
            of this campaign’s contacts in the table
            {clay.valid ? '.' : '. Check it’s the right table (analysis needs at least half).'}
          </p>
          {!clay.valid && (
            <p className="mt-1 text-xs text-ink-muted">
              If you only just switched on sync (ClayQL) for this table, Clay may still be copying it, which can take a while for big tables. Check again
              later.
            </p>
          )}
          <p className="mt-1 text-xs text-ink-muted">Checked {formatDateTime(clay.checkedAt)}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <a href={clay.tableUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              Open in Clay <ExternalLink size={12} />
            </a>
            <button onClick={() => check(clay.tableUrl)} className="text-brand hover:underline">
              Check again
            </button>
            <button onClick={() => setEditing(true)} className="text-brand hover:underline">
              Change table
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-red-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </Step>
  );
}
