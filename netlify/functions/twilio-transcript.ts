import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { loadMediaCall, storeTranscript } from './_lib/media';

/**
 * POST /api/twilio/transcript: Voice Intelligence's webhook when a transcript is ready.
 * The body isn't trusted: we only take the transcript sid from it, look it up on a call we started, and fetch the
 * transcript itself from Twilio's API. A fake request can at most trigger a refetch.
 */
export default handler(async (req) => {
  const text = await req.text();
  let sid: string | null = null;
  try {
    sid = (JSON.parse(text) as { transcript_sid?: string }).transcript_sid ?? null;
  } catch {
    sid = new URLSearchParams(text).get('transcript_sid');
  }
  if (!sid || !/^GT[0-9a-f]{32}$/i.test(sid)) return json({ ok: true });

  const row = must(await db().from('calls').select('id').eq('transcript_sid', sid).maybeSingle()) as { id: string } | null;
  if (!row) return json({ ok: true });
  const call = await loadMediaCall(row.id);
  if (call) await storeTranscript(call);
  return json({ ok: true });
});

export const config: Config = { path: '/api/twilio/transcript', method: 'POST' };
