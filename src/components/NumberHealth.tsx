import { useMemo, useState } from 'react';
import { must, useLoad } from '../lib/api';
import { addDays, sydneyToday } from '../lib/format';
import { supabase } from '../lib/supabase';
import { Tabs } from './ui/Tabs';

type Bucket = 'week' | 'day';
const PERIODS: Record<Bucket, number> = { week: 12, day: 30 };

interface Point {
  bucket: string;
  dials: number;
  answered: number;
  human: number;
}

// Chart geometry (SVG user units; the SVG scales to its container's width).
const W = 640;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

/** The start of each bucket (Monday for weeks, Sydney time), oldest first, matching dialer_number_health. */
function bucketStarts(bucket: Bucket): string[] {
  const today = sydneyToday();
  const [y, m, d] = today.split('-').map(Number);
  const monday = addDays(today, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
  const n = PERIODS[bucket];
  return Array.from({ length: n }, (_, i) => (bucket === 'week' ? addDays(monday, -7 * (n - 1 - i)) : addDays(today, -(n - 1 - i))));
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

/**
 * Number health: the share of dials from this number that a person answered, by week or day. A number being
 * labelled as spam shows up as this rate falling while dials stay steady. One series, so no legend; the hover
 * readout and the table below carry the counts.
 */
export function NumberHealth({ e164 }: { e164: string }) {
  const [bucket, setBucket] = useState<Bucket>('week');
  const [hover, setHover] = useState<number | null>(null);
  const data = useLoad(
    async () => must(await supabase.rpc('dialer_number_health', { p_e164: e164, p_bucket: bucket, p_periods: PERIODS[bucket] })) as Point[],
    [e164, bucket],
  );

  const points = useMemo(() => {
    const byBucket = new Map((data.data ?? []).map((p) => [p.bucket, p]));
    return bucketStarts(bucket).map((b) => byBucket.get(b) ?? { bucket: b, dials: 0, answered: 0, human: 0 });
  }, [data.data, bucket]);
  const totals = points.reduce((t, p) => ({ dials: t.dials + p.dials, human: t.human + p.human }), { dials: 0, human: 0 });

  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (rate: number) => PAD.top + (1 - rate) * plotH;
  const rated = points.map((p, i) => ({ ...p, i, rate: p.dials ? p.human / p.dials : null }));
  const withRate = rated.filter((p): p is typeof p & { rate: number } => p.rate != null);
  // Join consecutive periods that had dials; a period with none leaves a gap rather than a misleading zero.
  const segments: (typeof withRate)[] = [];
  for (const p of withRate) {
    const last = segments[segments.length - 1];
    if (last && last[last.length - 1].i === p.i - 1) last.push(p);
    else segments.push([p]);
  }
  const hovered = hover != null ? rated[hover] : null;
  const labelEvery = bucket === 'week' ? 3 : 7;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / plotW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-[15px] font-medium">Human pickup rate</p>
          <p className="text-sm text-ink-muted">
            {totals.dials ? `${pct(totals.human, totals.dials)} of ${totals.dials.toLocaleString()} dials over the last ${PERIODS[bucket]} ${bucket === 'week' ? 'weeks' : 'days'}. ` : 'No dials from this number in this period. '}
            A steady fall can mean the number is being flagged as spam.
          </p>
        </div>
        <Tabs
          label="Group by"
          value={bucket}
          onChange={(b) => {
            setBucket(b);
            setHover(null);
          }}
          tabs={[
            { value: 'week', label: 'Weekly' },
            { value: 'day', label: 'Daily' },
          ]}
        />
      </div>

      {data.error ? (
        <p className="text-sm text-red-600">{data.error}</p>
      ) : (
        <div className={`relative transition-opacity ${data.loading ? 'opacity-50' : ''}`}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full touch-none select-none"
            role="img"
            aria-label={`Human pickup rate by ${bucket} for this number`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e3e3e3" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-ink-muted text-[11px] tabular-nums">
                  {Math.round(t * 100)}%
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === (points.length - 1) % labelEvery ? (
                // Edge labels hug the plot so they aren't cut off.
                <text key={p.bucket} x={x(i)} y={H - 6} textAnchor={i === points.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'} className="fill-ink-muted text-[11px]">
                  {shortDate(p.bucket)}
                </text>
              ) : null,
            )}
            {hovered && <line x1={x(hovered.i)} x2={x(hovered.i)} y1={PAD.top} y2={PAD.top + plotH} stroke="#cccccc" strokeWidth={1} />}
            {segments.map((seg) => (
              <polyline
                key={seg[0].bucket}
                points={seg.map((p) => `${x(p.i)},${y(p.rate)}`).join(' ')}
                fill="none"
                stroke="#2464d7"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {withRate.map((p) => (
              <circle key={p.bucket} cx={x(p.i)} cy={y(p.rate)} r={hover === p.i ? 5 : 4} fill="#2464d7" stroke="#ffffff" strokeWidth={2} />
            ))}
          </svg>
          {hovered && (
            <div
              className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-xl border border-line bg-white px-3 py-2 text-sm shadow-lg"
              style={{ left: `${(x(hovered.i) / W) * 100}%` }}
            >
              <p className="font-display font-medium tabular-nums">{hovered.dials ? `${pct(hovered.human, hovered.dials)} human pickup` : 'No dials'}</p>
              <p className="text-xs text-ink-muted">
                {bucket === 'week' ? `Week of ${shortDate(hovered.bucket)}` : shortDate(hovered.bucket)}
                {hovered.dials ? ` · ${hovered.human} of ${hovered.dials} dials` : ''}
              </p>
            </div>
          )}
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted hover:text-ink">Show as a table</summary>
        <table className="mt-2 w-full">
          <thead className="border-b border-line">
            <tr>
              <th className="th">{bucket === 'week' ? 'Week of' : 'Day'}</th>
              <th className="th text-right">Dials</th>
              <th className="th text-right">Answered</th>
              <th className="th text-right">Human pickups</th>
              <th className="th text-right">Human pickup rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[...points].reverse().map((p) => (
              <tr key={p.bucket}>
                <td className="td">{shortDate(p.bucket)}</td>
                <td className="td text-right tabular-nums">{p.dials}</td>
                <td className="td text-right tabular-nums">{p.answered}</td>
                <td className="td text-right tabular-nums">{p.human}</td>
                <td className="td text-right tabular-nums">{pct(p.human, p.dials)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
