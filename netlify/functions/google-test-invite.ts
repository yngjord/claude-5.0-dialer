import type { Config } from '@netlify/functions';
import { randomBytes } from 'node:crypto';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { calendarAccessToken, createInvite } from './_lib/google';
import { handler, HttpError, json, readJson } from './_lib/http';
import { zonedTimeToUtc } from '../../shared/time';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/admin/calendar/test-invite { airtableClientId, email }: puts a 15-minute "test invite" on the host's
 * calendar for tomorrow at 10am Sydney time and invites `email`, to check the connection end to end.
 */
export default handler(async (req) => {
  const [me, body] = await Promise.all([requireDialerUser(req), readJson<{ airtableClientId: string; email: string }>(req)]);
  requireAdmin(me);
  const email = (body.email ?? '').trim();
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter an email address to invite.');
  const cal = must(await db().from('dialer_client_calendars').select('google_email').eq('airtable_client_id', body.airtableClientId).maybeSingle()) as {
    google_email: string | null;
  } | null;
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const res = await createInvite(await calendarAccessToken(body.airtableClientId), {
    id: `mt${randomBytes(12).toString('hex')}`,
    summary: 'Test invite from the Maronly Dialer',
    description: 'A test of the calendar connection. You can delete this event.',
    start: zonedTimeToUtc(tomorrow, '10:00', 'Australia/Sydney'),
    minutes: 15,
    timeZone: 'Australia/Sydney',
    guests: [email],
    hostEmail: cal?.google_email,
  });
  return json({ ok: true, htmlLink: res.htmlLink ?? null });
});

export const config: Config = { path: '/api/admin/calendar/test-invite', method: 'POST' };
