import type { Config } from '@netlify/functions';
import type { CallMediaResponse, CallRow } from '../../shared/types';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json } from './_lib/http';
import { loadMediaCall, processRecording, signedRecordingUrl, storeTranscript } from './_lib/media';

/**
 * GET /api/call-media?id=…: a short-lived recording link and the transcript for one call. Also finishes any
 * recording copy / transcript the webhooks didn't get to, so a just-finished call plays straight away.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const id = new URL(req.url).searchParams.get('id');
  if (!id) throw new HttpError(400, 'Missing call id.');

  const access = must(await db().from('dialer_calls').select('user_id').eq('id', id).maybeSingle()) as Pick<CallRow, 'user_id'> | null;
  if (!access) throw new HttpError(404, 'Call not found.');
  // Same rule as the dialer_calls RLS policy: reps only ever get their own calls.
  if (me.role !== 'admin' && access.user_id !== me.userId) throw new HttpError(403, "You don't have access to this call.");

  const call = await loadMediaCall(id);
  if (call?.recording_sid && (!call.recording_path || !call.transcript_status)) {
    await processRecording(call).catch((err) => console.error('Recording processing failed', id, err));
  }
  if (call?.transcript_status === 'pending') await storeTranscript(call).catch((err) => console.error('Transcript fetch failed', id, err));

  const row = must(await db().from('dialer_calls').select('recording_path, transcript, transcript_json, transcript_status').eq('id', id).single()) as Pick<
    CallRow,
    'recording_path' | 'transcript' | 'transcript_json' | 'transcript_status'
  >;
  return json({
    recordingUrl: row.recording_path ? await signedRecordingUrl(row.recording_path) : null,
    transcript: row.transcript,
    transcriptJson: row.transcript_json,
    transcriptStatus: row.transcript_status,
  } satisfies CallMediaResponse);
});

export const config: Config = { path: '/api/call-media', method: 'GET' };
