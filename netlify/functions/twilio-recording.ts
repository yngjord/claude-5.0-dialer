import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { loadMediaCall, processRecording } from './_lib/media';
import { verifyTwilioWebhook } from './_lib/twilio';

/**
 * POST /api/twilio/recording?callId=…: a call recording or voicemail is ready. Saves it to Supabase Storage and
 * starts the transcript. If that fails or times out, the sweep function (every 10 minutes) finishes the job.
 */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const callId = new URL(req.url).searchParams.get('callId');
  if (!callId || p.RecordingStatus !== 'completed' || !p.RecordingSid) return json({ ok: true });

  must(
    await db()
      .from('calls')
      .update({ recording_sid: p.RecordingSid, recording_duration_s: Number.parseInt(p.RecordingDuration ?? '0', 10) || 0 })
      .eq('id', callId),
  );

  const call = await loadMediaCall(callId);
  if (call) await processRecording(call).catch((err) => console.error('Recording processing failed; the sweep will retry', callId, err));
  return json({ ok: true });
});

export const config: Config = { path: '/api/twilio/recording', method: 'POST' };
