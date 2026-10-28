import { useMemo, useState } from 'react';
import { must, useLoad } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Tabs } from './ui/Tabs';

export interface Cell {
  dow: number;
  hour: number;
  dials: number;
  human: number;
}
type View = 'hour' | 'day';

// Bars with fewer dials than this are drawn faded: too few calls to trust the rate.
const MIN_DIALS = 10;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

// Chart geometry (SVG user units; the SVG scales to its container's width).
const W = 640;
const H = 220;
const PAD = { top: 14, right: 8, bottom: 28, left: 40 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

/**
 * Admin Performance: human pickup rate by hour of day or weekday (Sydney time), for the filters above (date range,
 * client, campaign), to find the best times to call. One series, so no legend; hover and the table carry the counts.
 */
export function PickupTimes({ from, to, clientName, campaignId }: { from: string; to: string; clientName: string | null; campaignId: string | null }) {
  const data = useLoad(
    async () => must(await supabase.rpc('dialer_pickup_by_time', { p_from: from, p_to: to, p_client_name: clientName, p_campaign_id: campaignId })) as Cell[],
    [from, to, clientName, campaignId],
  );
  return <PickupTimesChart data={data} />;
}

export function PickupTimesChart({ data }: { data: { data: Cell[] | null | undefined; loading: boolean; error: string | null } }) {
  const [view, setView] = useState<View>('hour');
  const [hover, setHover] = useState<number | null>(null);

  const bars = useMemo(() => {
    const cells = data.data ?? [];
    if (view === 'day') {
      const days = DAYS.map((label, i) => ({ key: i + 1, label, dials: 0, human: 0 }));
      for (const c of cells) {
        days[c.dow - 1].dials += c.dials;
        days[c.dow - 1].human += c.human;
      }
      // Weekends only when someone dialled then.
      return days.filter((d) => d.key <= 5 || d.dials > 0);
    }
    const hours = new Map<number, { key: number; label: string; dials: number; human: number }>();
    for (const c of cells) {
      const h = hours.get(c.hour) ?? { key: c.hour, label: hourLabel(c.hour), dials: 0, human: 0 };
      h.dials += c.dials;
      h.human += c.human;
      hours.set(c.hour, h);
    }
    // Business hours always shown, plus any other hour that had dials.
    const keys = [...new Set([...Array.from({ length: 11 }, (_, i) => i + 8), ...hours.keys()])].sort((a, b) => a - b);
    return keys.map((k) => hours.get(k) ?? { key: k, label: hourLabel(k), dials: 0, human: 0 });
  }, [data.data, view]);

  const max = Math.max(0.25, ...bars.map((b) => (b.dials ? b.human / b.dials : 0)));
  const top = Math.ceil(max * 4) / 4; // y axis to the next 25%
  const ticks = Array.from({ length: Math.round(top * 4) + 1 }, (_, i) => i * 0.25);
  const slot = plotW / Math.max(bars.length, 1);
  const barW = Math.min(36, slot * 0.6);
  const y = (rate: number) => PAD.top + (1 - rate / top) * plotH;
  const best = bars.filter((b) => b.dials >= MIN_DIALS).sort((a, b) => b.human / b.dials - a.human / a.dials)[0];
  const hovered = hover != null ? bars[hover] : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-[15px] font-medium">Best times to call</p>
          <p className="text-sm text-ink-muted">
            Human pickup rate by {view === 'hour' ? 'hour of day' : 'weekday'}, Sydney time.{' '}
            {best ? `Best: ${best.label} (${pct(best.human, best.dials)} of ${best.dials} dials).` : `Not enough calls yet: a ${view === 'hour' ? 'time' : 'day'} needs ${MIN_DIALS}+ dials to rank.`}
          </p>
        </div>
        <Tabs
          label="Group by"
          value={view}
          onChange={(v) => {
            setView(v);
            setHover(null);
          }}
          tabs={[
            { value: 'hour', label: 'Hour' },
            { value: 'day', label: 'Weekday' },
          ]}
        />
      </div>

      {data.error ? (
        <p className="text-sm text-red-600">{data.error}</p>
      ) : (
        <div className={`relative transition-opacity ${data.loading ? 'opacity-50' : ''}`}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none" role="img" aria-label={`Human pickup rate by ${view === 'hour' ? 'hour of day' : 'weekday'}`} onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e3e3e3" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-ink-muted text-[11px] tabular-nums">
                  {Math.round(t * 100)}%
                </text>
              </g>
            ))}
            {bars.map((b, i) => {
              const cx = PAD.left + slot * i + slot / 2;
              const rate = b.dials ? b.human / b.dials : 0;
              const h = Math.max(0, y(0) - y(rate));
              const r = Math.min(4, barW / 2, h);
              const x0 = cx - barW / 2;
              const y0 = y(0) - h;
              return (
                <g key={b.key} onPointerEnter={() => setHover(i)}>
                  {/* Hit area: the whole column, bigger than the bar. */}
                  <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                  {hover === i && <rect x={PAD.left + slot * i + 1} y={PAD.top} width={slot - 2} height={plotH} fill="#f3f3f3" />}
                  {h > 0 && (
                    <path
                      d={`M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z`}
                      fill="#2464d7"
                      opacity={b.dials >= MIN_DIALS ? 1 : 0.35}
                    />
                  )}
                  <text x={cx} y={H - 8} textAnchor="middle" className="fill-ink-muted text-[11px]">
                    {b.label}
                  </text>
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#cccccc" strokeWidth={1} />
          </svg>
          {hovered && (
            <div
              className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-xl border border-line bg-white px-3 py-2 text-sm shadow-lg"
              style={{ left: `${((PAD.left + slot * (hover ?? 0) + slot / 2) / W) * 100}%` }}
            >
              <p className="font-display font-medium tabular-nums">{hovered.dials ? `${pct(hovered.human, hovered.dials)} human pickup` : 'No dials'}</p>
              <p className="text-xs text-ink-muted">
                {view === 'hour' ? `${hovered.label}–${hourLabel((hovered.key + 1) % 24)}` : hovered.label}
                {hovered.dials ? ` · ${hovered.human} of ${hovered.dials} dials` : ''}
                {hovered.dials > 0 && hovered.dials < MIN_DIALS ? ' · too few to trust' : ''}
              </p>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink-muted">Faded bars have fewer than {MIN_DIALS} dials. Failed calls (never reached the network) aren't counted.</p>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted hover:text-ink">Show as a table</summary>
        <table className="mt-2 w-full">
          <thead className="border-b border-line">
            <tr>
              <th className="th">{view === 'hour' ? 'Hour' : 'Weekday'}</th>
              <th className="th text-right">Dials</th>
              <th className="th text-right">Human pickups</th>
              <th className="th text-right">Human pickup rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {bars.map((b) => (
              <tr key={b.key}>
                <td className="td">{view === 'hour' ? `${b.label}–${hourLabel((b.key + 1) % 24)}` : b.label}</td>
                <td className="td text-right tabular-nums">{b.dials}</td>
                <td className="td text-right tabular-nums">{b.human}</td>
                <td className="td text-right tabular-nums">{pct(b.human, b.dials)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
