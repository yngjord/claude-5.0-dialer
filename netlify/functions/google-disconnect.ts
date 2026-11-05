import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { decrypt, revoke } from './_lib/google';
import { handler, json, readJson } from './_lib/http';

/** POST /api/admin/calendar/disconnect { airtableClientId }: revokes Google access and deletes the stored token. */
export default handler(async (req) => {
  const [me, body] = await Promise.all([requireDialerUser(req), readJson<{ airtableClientId: string }>(req)]);
  requireAdmin(me);
  const row = must(await db().from('dialer_calendar_tokens').select('refresh_token_enc').eq('airtable_client_id', body.airtableClientId).maybeSingle()) as {
    refresh_token_enc: string;
  } | null;
  if (row) {
    try {
      await revoke(decrypt(row.refresh_token_enc));
    } catch (err) {
      console.error('Revoking Google access failed', err);
    }
    must(await db().from('dialer_calendar_tokens').delete().eq('airtable_client_id', body.airtableClientId));
  }
  must(
    await db()
      .from('dialer_client_calendars')
      .update({ status: 'disconnected', invites_enabled: false, last_error: null })
      .eq('airtable_client_id', body.airtableClientId),
  );
  return json({ ok: true });
});

export const config: Config = { path: '/api/admin/calendar/disconnect', method: 'POST' };
