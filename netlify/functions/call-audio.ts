import type { Config } from '@netlify/functions';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 3_600_000 ? Math.round(v) : null);
const text = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * POST /api/call-audio { callId, report }: what an answered call sounded like in the rep's browser (how long until
 * they heard the prospect, quality warnings, devices). Only the rep who made the call can report it.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const { callId, report } = await readJson<{ callId: string; report: Record<string, unknown> }>(req);
  const call = must(await db().from('dialer_calls').select('id, user_id').eq('id', callId ?? '').maybeSingle()) as { id: string; user_id: string | null } | null;
  if (!call) throw new HttpError(404, 'Call not found.');
  if (call.user_id !== me.userId) throw new HttpError(403, 'Not your call.');
  const r = report ?? {};
  const clean = {
    heard_ms: num(r.heard_ms),
    spoke_ms: num(r.spoke_ms),
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string').slice(0, 12).map((w) => w.slice(0, 40)) : [],
    mic: text(r.mic),
    speaker: text(r.speaker),
    browser: text(r.browser, 60),
    edge: text(r.edge, 30),
    timeline: Array.isArray(r.timeline)
      ? r.timeline.slice(0, 12).map((x: Record<string, unknown>) => ({
          t: typeof x?.t === 'number' && Number.isFinite(x.t) ? Math.round(x.t * 10) / 10 : null,
          rx: num(x?.rx),
          tx: num(x?.tx),
          lost: num(x?.lost),
          in: num(x?.in),
          out: num(x?.out),
          rtt: num(x?.rtt),
        }))
      : [],
  };
  must(await db().from('dialer_calls').update({ client_audio: clean }).eq('id', call.id));
  return json({ ok: true });
});

export const config: Config = { path: '/api/call-audio', method: 'POST' };
