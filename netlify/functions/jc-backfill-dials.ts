import type { Config } from '@netlify/functions';
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { db } from './_lib/db';
import { handler, HttpError, json } from './_lib/http';
import { SEALED, TOKEN_SHA256 } from './_lib/jcBackfillData';

/**
 * TEMPORARY (deleted after use): POST /api/jc-backfill-dials adds the JustCall dials that weren't imported before
 * (no recordings). The rows are encrypted; the caller's x-backfill-token both authorises and decrypts them.
 * Idempotent: rows whose Twilio call SID already exists are skipped. ?dry=1 only counts.
 */
export default handler(async (req) => {
  const token = req.headers.get('x-backfill-token') ?? '';
  const given = createHash('sha256').update(token).digest();
  if (!token || !timingSafeEqual(given, Buffer.from(TOKEN_SHA256, 'hex'))) throw new HttpError(403, 'Forbidden');
  const [iv, tag, ct] = SEALED.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('jc-backfill-key:' + token).digest(), iv);
  decipher.setAuthTag(tag);
  const rows = JSON.parse(gunzipSync(Buffer.concat([decipher.update(ct), decipher.final()])).toString('utf8')) as { twilio_call_sid: string }[];

  const sids = rows.map((r) => r.twilio_call_sid);
  const existing = new Set<string>();
  for (let i = 0; i < sids.length; i += 300) {
    const { data, error } = await db().from('dialer_calls').select('twilio_call_sid').in('twilio_call_sid', sids.slice(i, i + 300));
    if (error) throw new Error(error.message);
    data.forEach((d) => existing.add(d.twilio_call_sid as string));
  }
  const todo = rows.filter((r) => !existing.has(r.twilio_call_sid));
  if (new URL(req.url).searchParams.get('dry')) return json({ rows: rows.length, alreadyThere: existing.size, wouldInsert: todo.length });

  let inserted = 0;
  for (let i = 0; i < todo.length; i += 400) {
    const { data, error } = await db().from('dialer_calls').upsert(todo.slice(i, i + 400), { onConflict: 'twilio_call_sid', ignoreDuplicates: true }).select('id');
    if (error) throw new HttpError(500, `Insert failed after ${inserted} rows: ${error.message}`);
    inserted += data.length;
  }
  return json({ rows: rows.length, alreadyThere: existing.size, inserted });
});

export const config: Config = { path: '/api/jc-backfill-dials', method: 'POST' };
