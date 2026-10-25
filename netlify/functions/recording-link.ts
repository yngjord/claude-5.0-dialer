import type { Config } from '@netlify/functions';
import { LEAD_DISPOSITIONS } from '../../shared/constants';
import type { CallRow } from '../../shared/types';
import { db, must } from './_lib/db';
import { loadMediaCall, processRecording, signedRecordingUrl } from './_lib/media';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/**
 * GET /r/{callId}.mp3: the permanent recording link written to Airtable Leads → Call Recording Link, which the
 * portal and OS open like the old JustCall S3 links. No login: the call id can't be guessed, and only calls that
 * created a lead (the two "Interested" dispositions) are served. Redirects to a fresh short-lived signed URL, so
 * the recordings bucket stays private and deleting a recording kills its link.
 */
export default async (req: Request): Promise<Response> => {
  try {
    const id = (new URL(req.url).pathname.split('/').pop() ?? '').replace(/\.mp3$/i, '');
    if (!UUID.test(id)) return text('Recording not found.', 404);

    const row = must(await db().from('dialer_calls').select('disposition, recording_path').eq('id', id).maybeSingle()) as Pick<
      CallRow,
      'disposition' | 'recording_path'
    > | null;
    if (!row || !row.disposition || !LEAD_DISPOSITIONS.includes(row.disposition)) return text('Recording not found.', 404);

    let path = row.recording_path;
    if (!path) {
      // Opened before the recording webhook finished: copy it from Twilio now, like the call log does.
      const call = await loadMediaCall(id);
      if (call?.recording_sid) {
        await processRecording(call).catch((err) => console.error('Recording processing failed', id, err));
        path = call.recording_path;
      }
    }
    if (!path) return text("This recording isn't ready yet. Try again in a minute.", 404);

    const url = await signedRecordingUrl(path);
    if (!url) return text('Recording not found.', 404);
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(err);
    return text('Something went wrong. Please try again.', 500);
  }
};

export const config: Config = { path: '/r/:id', method: 'GET' };
