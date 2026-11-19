import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { must, useLoad } from '../lib/api';
import type { DateRange } from '../lib/dateRange';
import { supabase } from '../lib/supabase';
import { bucketSize, makeBuckets, type BucketSize } from '../lib/trendBuckets';

type SeriesKey = 'dials' | 'connects' | 'leads' | 'appointments';
interface TrendRow extends Record<SeriesKey, number> {
  bucket: string;
}

// Fixed order and colours (validated for colour-blind separation on white); a hidden series keeps its colour.
const SERIES: Record<SeriesKey, { label: string; color: string }> = {
  dials: { label: 'Calls made', color: '#2a78d6' },
  connects: { label: 'Human answers', color: '#1baf7a' },
  leads: { label: 'Leads created (incl. meetings)', color: '#eb6834' },
  appointments: { label: 'Meetings booked', color: '#6250d6' },
};
const ORDER: SeriesKey[] = ['dials', 'connects', 'leads', 'appointments'];
const PER: Record<BucketSize, string> = { hour: 'hour', day: 'day', week: 'week', month: 'month' };

function niceScale(max: number): { top: number; ticks: number[] } {
  const target = Math.max(max, 4);
  const rough = target / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough)!;
  const top = Math.ceil(target / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** Monotone cubic (Fritsch–Carlson) path: smooth, never dips below 0 or overshoots a peak. */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const slope = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const m = pts.map((_, i) => (i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 30, left: 40 };

/**
 * Admin Performance: calls made, human answers, leads and meetings over time, for the page's date range, client and
 * campaign. Same look as the client portal's Lead activity chart; the legend switches series on and off.
 */
export function PerformanceTrend({ range, from, to, clientName, campaignId }: { range: DateRange; from: string; to: string; clientName: string | null; campaignId: string | null }) {
  const size = bucketSize(range);
  const data = useLoad(
    async () =>
      must(await supabase.rpc('dialer_performance_trend', { p_from: from, p_to: to, p_bucket: size, p_client_name: clientName, p_campaign_id: campaignId })) as TrendRow[],
    // An open-ended range's end is "now", which moves on every render: refetch at most once a minute for it.
    [from, to.slice(0, 16), size, clientName, campaignId],
  );
  const [shown, setShown] = useState<Set<SeriesKey>>(new Set(ORDER));
  const [rawHover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const loading = data.loading && !data.data;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const rows = useMemo(() => data.data ?? [], [data.data]);
  const buckets = useMemo(() => makeBuckets(range, size, rows.map((r) => r.bucket)), [range, size, rows]);
  const counts = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.bucket, r]));
    return Object.fromEntries(ORDER.map((k) => [k, buckets.map((b) => byKey.get(b.key)?.[k] ?? 0)])) as Record<SeriesKey, number[]>;
  }, [rows, buckets]);

  const visible = ORDER.filter((k) => shown.has(k));
  const totals = Object.fromEntries(ORDER.map((k) => [k, counts[k].reduce((a, b) => a + b, 0)])) as Record<SeriesKey, number>;
  const { top, ticks } = niceScale(Math.max(0, ...visible.flatMap((k) => counts[k])));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const last = buckets.length - 1;
  const x = (i: number) => (last > 0 ? PAD.left + (i / last) * plotW : PAD.left + plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const hover = rawHover !== null && rawHover <= last ? rawHover : null;
  const labelEvery = Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 70)));

  const toggle = (key: SeriesKey) =>
    setShown((prev) => {
      if (prev.has(key) && prev.size === 1) return prev; // keep at least one series
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (last < 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - PAD.left) / (plotW || 1);
    setHover(last > 0 ? Math.min(last, Math.max(0, Math.round(rel * last))) : 0);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setHover((h) => Math.min(last, Math.max(0, (h ?? last) + (e.key === 'ArrowRight' ? 1 : -1))));
    }
  };

  const tipLeft = hover !== null ? Math.min(Math.max(x(hover), 120), width - 120) : 0;
  const summary = visible.map((k) => `${SERIES[k].label}: ${totals[k]}`).join(', ');

  return (
    <section className="card mt-8 animate-appear p-4 sm:p-6" aria-busy={loading}>
      <div className="mb-4">
        <h2 className="font-display text-lg font-medium">Activity over time</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Per {PER[size]}, Sydney time · {clientName ?? 'all clients'}
        </p>
      </div>

      {/* The legend doubles as the series toggle. */}
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Series">
        {ORDER.map((k) => {
          const on = shown.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              aria-pressed={on}
              className={`inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition ${
                on ? 'border-line-strong bg-white text-ink' : 'border-line bg-neutral-50 text-ink-faint hover:text-ink-muted'
              }`}
            >
              <span className="h-[3px] w-4 rounded-full" style={{ background: on ? SERIES[k].color : '#d4d4d4' }} aria-hidden />
              {SERIES[k].label}
              <span className="tabular-nums text-ink-muted">{loading ? '' : totals[k].toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      {data.error ? (
        <p className="text-sm text-red-600">{data.error}</p>
      ) : loading ? (
        <div className="skeleton w-full" style={{ height: HEIGHT }} aria-label="Loading chart" />
      ) : (
        <div ref={box} className={`relative transition-opacity ${data.loading ? 'opacity-60' : ''}`} style={{ height: HEIGHT }}>
          {width > 0 && (
            <svg
              width={width}
              height={HEIGHT}
              className="block touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              role="img"
              aria-label={`Activity per ${PER[size]}. ${summary}. Arrow keys step through points.`}
              tabIndex={0}
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              <defs>
                {ORDER.map((k) => (
                  <linearGradient key={k} id={`trend-area-${k}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={SERIES[k].color} stopOpacity="0.14" />
                    <stop offset="100%" stopColor={SERIES[k].color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>

              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="#ececec" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={PAD.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-faint text-[11px] tabular-nums">
                    {t.toLocaleString()}
                  </text>
                </g>
              ))}

              {buckets.map((b, i) =>
                i % labelEvery === last % labelEvery ? (
                  <text key={b.key} x={x(i)} y={HEIGHT - 8} textAnchor={last === 0 ? 'middle' : i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-ink-faint text-[11px]">
                    {b.axis}
                  </text>
                ) : null,
              )}

              {visible.map((k) => {
                const line = smoothPath(counts[k].map((v, i) => [x(i), y(v)]));
                return (
                  <g key={`${k}-${size}-${buckets.length}`}>
                    {last > 0 && <path d={`${line} L${x(last)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#trend-area-${k})`} className="animate-fade-in" />}
                    <path d={line} fill="none" stroke={SERIES[k].color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="animate-draw" />
                    {last === 0 && <circle cx={x(0)} cy={y(counts[k][0])} r={4.5} fill={SERIES[k].color} stroke="#fff" strokeWidth={2} />}
                  </g>
                );
              })}

              {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="#cccccc" strokeWidth={1} shapeRendering="crispEdges" />}
              {hover !== null && visible.map((k) => <circle key={k} cx={x(hover)} cy={y(counts[k][hover])} r={4.5} fill={SERIES[k].color} stroke="#fff" strokeWidth={2} />)}
            </svg>
          )}

          {hover !== null && (
            <div className="pointer-events-none absolute top-1 z-10 min-w-[220px] -translate-x-1/2 rounded-xl border border-line bg-white px-3 py-2.5 shadow-card" style={{ left: tipLeft }} role="status">
              <p className="mb-1.5 text-xs text-ink-muted">{buckets[hover].long}</p>
              {visible.map((k) => (
                <p key={k} className="flex items-center gap-2 py-0.5 text-sm">
                  <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: SERIES[k].color }} aria-hidden />
                  <span className="text-ink-muted">{SERIES[k].label}</span>
                  <span className="ml-auto pl-4 font-semibold tabular-nums">{counts[k][hover].toLocaleString()}</span>
                </p>
              ))}
            </div>
          )}

          {/* Screen-reader equivalent of the chart. */}
          <div className="sr-only">
            <table>
              <caption>Activity per {PER[size]}</caption>
              <thead>
                <tr>
                  <th>Period</th>
                  {visible.map((k) => (
                    <th key={k}>{SERIES[k].label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets.map((b, i) => (
                  <tr key={b.key}>
                    <td>{b.long}</td>
                    {visible.map((k) => (
                      <td key={k}>{counts[k][i]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
