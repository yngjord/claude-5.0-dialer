import { useCallback, useMemo, useState } from 'react';
import { must, useLoad } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Tabs } from './ui/Tabs';

export interface Cell {
  dow: number;
  hour: number;
  dials: number;
  human: number;
}
/** One rep's dialing session (dialer_dialing_sessions), with its pickups in each third. */
export interface DialingSession {
  user_id: string;
  agent_name: string | null;
  started_at: string;
  ended_at: string;
  dials: number;
  rated: number;
  human: number;
  client_names: string | null;
  from_numbers: string | null;
  t1_dials: number;
  t1_human: number;
  t2_dials: number;
  t2_human: number;
  t3_dials: number;
  t3_human: number;
}
type SessionCall = { started_at: string; pickup_status: string | null };
type View = 'hour' | 'day' | 'session';
type Loaded<T> = { data: T[] | null | undefined; loading: boolean; error: string | null };
type Bar = { key: number; label: string; dials: number; human: number; sessions?: number; detail?: string };

// Session view: only sessions this long (a 15+ minute gap starts a new one) are split into thirds.
export const SESSION_MIN_DIALS = 30;
const PARTS = ['First third', 'Middle third', 'Last third'];
const VIEW_TEXT: Record<View, string> = {
  hour: 'by hour of day, Sydney time',
  day: 'by weekday, Sydney time',
  session: `through dialing sessions of ${SESSION_MIN_DIALS}+ calls, split into thirds`,
};
const sessionKey = (s: DialingSession) => `${s.user_id}|${s.started_at}`;
const TZ = 'Australia/Sydney';
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(' ', '');
const sessionLabel = (s: DialingSession) =>
  `${new Date(s.started_at).toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(s.started_at)} · ${s.agent_name ?? 'Unknown'} · ${s.client_names ?? 'No client'} · ${s.dials} dials · ${pct(s.human, s.rated)}`;
/** Calls per bar for one session: about 12 bars at most, in steps of 5. */
const blockSize = (n: number) => Math.max(5, Math.ceil(n / 12 / 5) * 5);

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
 * Admin Performance: human pickup rate by hour of day, weekday (Sydney time) or position in a dialing session, for
 * the filters above (date range, client, campaign), to find the best times to call and whether pickups fade or dip
 * as a session goes on. One series, so no legend; hover carries the counts.
 */
export function PickupTimes({ from, to, clientName, campaignId }: { from: string; to: string; clientName: string | null; campaignId: string | null }) {
  const data = useLoad(
    async () => must(await supabase.rpc('dialer_pickup_by_time', { p_from: from, p_to: to, p_client_name: clientName, p_campaign_id: campaignId })) as Cell[],
    [from, to, clientName, campaignId],
  );
  const sessions = useLoad(
    async () =>
      must(
        await supabase.rpc('dialer_dialing_sessions', { p_from: from, p_to: to, p_client_name: clientName, p_campaign_id: campaignId, p_min_dials: SESSION_MIN_DIALS }),
      ) as DialingSession[],
    [from, to, clientName, campaignId],
  );
  // One session's calls in order, with the same filters the session was built from.
  const loadCalls = useCallback(
    async (s: DialingSession) => {
      let q = supabase
        .from('dialer_calls')
        .select('started_at, pickup_status')
        .eq('user_id', s.user_id)
        .eq('direction', 'outbound')
        .eq('source', 'dialer')
        .eq('kind', 'call')
        .gte('started_at', s.started_at)
        .lte('started_at', s.ended_at);
      if (clientName) q = q.eq('client_name', clientName);
      if (campaignId) q = q.eq('campaign_id', campaignId);
      return must(await q.order('started_at')) as SessionCall[];
    },
    [clientName, campaignId],
  );
  return <PickupTimesChart data={data} sessions={sessions} loadCalls={loadCalls} />;
}

export function PickupTimesChart({
  data: times,
  sessions,
  loadCalls,
}: {
  data: Loaded<Cell>;
  sessions?: Loaded<DialingSession>;
  loadCalls?: (s: DialingSession) => Promise<SessionCall[]>;
}) {
  const [view, setView] = useState<View>('hour');
  const [hover, setHover] = useState<number | null>(null);
  // Session view: narrow to one rep, then optionally one of their sessions.
  const [rep, setRep] = useState('');
  const [picked, setPicked] = useState('');
  const repSessions = useMemo(() => (sessions?.data ?? []).filter((s) => !rep || s.user_id === rep), [sessions?.data, rep]);
  const reps = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of sessions?.data ?? []) byId.set(s.user_id, s.agent_name ?? 'Unknown');
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sessions?.data]);
  // A picked session that the filters no longer include falls back to all sessions.
  const one = repSessions.find((s) => sessionKey(s) === picked) ?? null;
  const calls = useLoad(async () => (one && loadCalls ? await loadCalls(one) : null), [one ? sessionKey(one) : '', loadCalls]);
  const data = view === 'session' ? (one ? calls : (sessions ?? times)) : times;
  // Bars from a single session are equal blocks of a few calls, so none is faded for being small.
  const minDials = view === 'session' && one ? 0 : MIN_DIALS;

  const bars = useMemo((): Bar[] => {
    if (view === 'session' && one) {
      const list = calls.data ?? [];
      const size = blockSize(list.length);
      const out: Bar[] = [];
      for (let i = 0; i < list.length; i += size) {
        const block = list.slice(i, i + size);
        const rated = block.filter((c) => c.pickup_status !== 'Failed');
        out.push({
          key: i,
          label: `${i + 1}–${i + block.length}`,
          dials: rated.length,
          human: rated.filter((c) => c.pickup_status === 'Human Pickup').length,
          detail: `Calls ${i + 1}–${i + block.length}, ${clock(block[0].started_at)}–${clock(block[block.length - 1].started_at)}`,
        });
      }
      return out;
    }
    if (view === 'session') {
      return PARTS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        return {
          key: n,
          label,
          dials: repSessions.reduce((sum, s) => sum + s[`t${n}_dials`], 0),
          human: repSessions.reduce((sum, s) => sum + s[`t${n}_human`], 0),
          sessions: repSessions.length,
        };
      });
    }
    const cells = times.data ?? [];
    if (view === 'day') {
      const days = DAYS.map((label, i) => ({ key: i + 1, label, dials: 0, human: 0 }));
      for (const c of cells) {
        days[c.dow - 1].dials += c.dials;
        days[c.dow - 1].human += c.human;
      }
      // Weekends only when someone dialled then.
      return days.filter((d) => d.key <= 5 || d.dials > 0);
    }
    const hours = new Map<number, Bar>();
    for (const c of cells) {
      const h = hours.get(c.hour) ?? { key: c.hour, label: hourLabel(c.hour), dials: 0, human: 0 };
      h.dials += c.dials;
      h.human += c.human;
      hours.set(c.hour, h);
    }
    // Business hours always shown, plus any other hour that had dials.
    const keys = [...new Set([...Array.from({ length: 11 }, (_, i) => i + 8), ...hours.keys()])].sort((a, b) => a - b);
    return keys.map((k) => hours.get(k) ?? { key: k, label: hourLabel(k), dials: 0, human: 0 });
  }, [times.data, repSessions, one, calls.data, view]);

  const max = Math.max(0.25, ...bars.map((b) => (b.dials ? b.human / b.dials : 0)));
  const top = Math.ceil(max * 4) / 4; // y axis to the next 25%
  const ticks = Array.from({ length: Math.round(top * 4) + 1 }, (_, i) => i * 0.25);
  const slot = plotW / Math.max(bars.length, 1);
  const barW = Math.min(36, slot * 0.6);
  const y = (rate: number) => PAD.top + (1 - rate / top) * plotH;
  const best = bars.filter((b) => b.dials >= Math.max(minDials, 1)).sort((a, b) => b.human / b.dials - a.human / a.dials)[0];
  const hovered = hover != null ? bars[hover] : null;
  const select = 'field !w-auto !rounded-full !py-2 text-sm';

  let summary: string;
  if (view === 'session' && one) {
    summary = `${one.agent_name ?? 'Unknown'}'s session on ${sessionLabel(one).split(' · ')[0]}–${clock(one.ended_at)}, ${one.client_names ?? 'no client'}, from ${one.from_numbers ?? 'unknown number'}: ${pct(one.human, one.rated)} human pickup over ${one.dials} calls, ${blockSize(calls.data?.length ?? one.dials)} calls per bar.`;
  } else if (view === 'session' && !repSessions.length) {
    summary = `Human pickup rate ${VIEW_TEXT.session}. No dialing sessions of ${SESSION_MIN_DIALS}+ calls in this period.`;
  } else {
    const sessionsNote = view === 'session' ? `, ${repSessions.length} session${repSessions.length === 1 ? '' : 's'}` : '';
    summary = `Human pickup rate ${VIEW_TEXT[view]}. ${
      best
        ? `Best: ${view === 'session' ? best.label.toLowerCase() : best.label} (${pct(best.human, best.dials)} of ${best.dials} dials${sessionsNote}).`
        : `Not enough calls yet: a ${view === 'hour' ? 'time' : view === 'day' ? 'day' : 'third'} needs ${MIN_DIALS}+ dials to rank.`
    }`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-[15px] font-medium">Best times to call</p>
          <p className="text-sm text-ink-muted">{summary}</p>
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
            ...(sessions ? [{ value: 'session' as const, label: 'Session' }] : []),
          ]}
        />
      </div>

      {view === 'session' && sessions && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Rep"
            className={select}
            value={rep}
            onChange={(e) => {
              setRep(e.target.value);
              setPicked('');
              setHover(null);
            }}
          >
            <option value="">All reps</option>
            {reps.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Session"
            className={`${select} max-w-full`}
            value={one ? picked : ''}
            onChange={(e) => {
              setPicked(e.target.value);
              setHover(null);
            }}
          >
            <option value="">All sessions, in thirds ({repSessions.length})</option>
            {repSessions.map((x) => (
              <option key={sessionKey(x)} value={sessionKey(x)}>
                {sessionLabel(x)}
              </option>
            ))}
          </select>
        </div>
      )}

      {data.error ? (
        <p className="text-sm text-red-600">{data.error}</p>
      ) : (
        <div className={`relative transition-opacity ${data.loading ? 'opacity-50' : ''}`}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none" role="img" aria-label={one && view === 'session' ? 'Human pickup rate through one session, start to finish' : `Human pickup rate ${VIEW_TEXT[view]}`} onPointerLeave={() => setHover(null)}>
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
                      opacity={b.dials >= minDials ? 1 : 0.35}
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
                {hovered.detail ?? (view === 'hour' ? `${hovered.label}–${hourLabel((hovered.key + 1) % 24)}` : hovered.label)}
                {hovered.dials ? ` · ${hovered.human} of ${hovered.dials} dials` : ''}
                {view === 'session' && hovered.sessions ? ` · ${hovered.sessions} session${hovered.sessions === 1 ? '' : 's'}` : ''}
                {hovered.dials > 0 && hovered.dials < minDials ? ' · too few to trust' : ''}
              </p>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink-muted">
        {minDials ? `Faded bars have fewer than ${minDials} dials. ` : ''}Failed calls (never reached the network) aren't counted.
        {view === 'session' && ' A session is one rep dialing without a break of more than 15 minutes; failed calls still count towards its length.'}
      </p>
    </div>
  );
}
