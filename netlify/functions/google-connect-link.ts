import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { sign } from './_lib/google';
import { handler, HttpError, json, readJson } from './_lib/http';

const LINK_DAYS = 7;

/**
 * POST /api/admin/calendar/link { airtableClientId, clientName }: a connect link (valid 7 days) to send the client's
 * host. Opening it takes them to Google to connect their own calendar; no dialer login needed.
 */
export default handler(async (req) => {
  const [me, body] = await Promise.all([requireDialerUser(req), readJson<{ airtableClientId: string; clientName: string }>(req)]);
  requireAdmin(me);
  if (!/^rec[A-Za-z0-9]{14}$/.test(body.airtableClientId ?? '')) throw new HttpError(400, 'Choose a client.');
  must(
    await db()
      .from('dialer_client_calendars')
      .upsert({ airtable_client_id: body.airtableClientId, client_name: (body.clientName ?? '').trim() }, { onConflict: 'airtable_client_id' }),
  );
  const token = sign({ c: body.airtableClientId }, LINK_DAYS * 86_400);
  return json({ url: `${new URL(req.url).origin}/api/google/connect?t=${token}`, expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString() });
});

export const config: Config = { path: '/api/admin/calendar/link', method: 'POST' };
