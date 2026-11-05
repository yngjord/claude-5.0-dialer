import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { calendarAccessToken } from './_lib/google';
import { handler, HttpError, json, readJson } from './_lib/http';

/**
 * POST /api/admin/calendar/check { airtableClientId }: asks Google whether the stored access still works. If Google
 * has revoked it, calendarAccessToken marks the client disconnected. Returns the current status either way.
 */
export default handler(async (req) => {
  const [me, body] = await Promise.all([requireDialerUser(req), readJson<{ airtableClientId: string }>(req)]);
  requireAdmin(me);
  const hasToken = must(await db().from('dialer_calendar_tokens').select('airtable_client_id').eq('airtable_client_id', body.airtableClientId).maybeSingle());
  if (hasToken) {
    try {
      await calendarAccessToken(body.airtableClientId);
    } catch (err) {
      // A revoked grant is recorded as Disconnected (and reported below); anything else is a real failure.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
  const row = must(await db().from('dialer_client_calendars').select('status, google_email').eq('airtable_client_id', body.airtableClientId).maybeSingle()) as {
    status: string;
    google_email: string | null;
  } | null;
  return json({ status: row?.status ?? 'not_connected', googleEmail: row?.google_email ?? null });
});

export const config: Config = { path: '/api/admin/calendar/check', method: 'POST' };
