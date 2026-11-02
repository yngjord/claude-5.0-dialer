import type { Config } from '@netlify/functions';
import type { CallRow } from '../../shared/types';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

/**
 * POST /api/call-share { id }: a permanent link to a call's recording that plays without a login
 * (/r/{callId}.mp3), for sharing outside the dialer. Marks the call as shared (only shared and lead calls are served
 * there). Same access as playing it: reps their own calls, admins any.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const { id } = await readJson<{ id: string }>(req);
  const call = must(await db().from('dialer_calls').select('id, user_id, recording_path, recording_sid, recording_shared_at').eq('id', id ?? '').maybeSingle()) as Pick<
    CallRow,
    'id' | 'user_id' | 'recording_path' | 'recording_sid'
  > & { recording_shared_at: string | null } | null;
  if (!call) throw new HttpError(404, 'Call not found.');
  if (me.role !== 'admin' && call.user_id !== me.userId) throw new HttpError(403, "You don't have access to this call.");
  if (!call.recording_path && !call.recording_sid) throw new HttpError(400, "This call doesn't have a recording.");
  if (!call.recording_shared_at) must(await db().from('dialer_calls').update({ recording_shared_at: new Date().toISOString() }).eq('id', call.id));
  return json({ url: `${new URL(req.url).origin}/r/${call.id}.mp3` });
});

export const config: Config = { path: '/api/call-share', method: 'POST' };
