import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { CONTACT, encrypt, exchangeCode, hostPage, revoke, verify } from './_lib/google';
import { handler } from './_lib/http';

/**
 * GET /api/google/callback: Google sends the host back here. Saves their refresh token (encrypted) against the
 * client and marks the calendar connected. Both calendar permissions must be ticked.
 */
export default handler(async (req) => {
  const url = new URL(req.url);
  const state = verify<{ c: string; t: string }>(url.searchParams.get('state'));
  if (!state) return hostPage('This link has expired', `Please open the link you were sent again, or ask ${CONTACT} for a new one.`, false);
  const retry = `<a href="/api/google/connect?t=${encodeURIComponent(state.t)}">Try again</a>`;
  if (url.searchParams.get('error')) return hostPage('Calendar not connected', `Google access wasn't given. ${retry} whenever you're ready.`, false);

  let conn;
  try {
    conn = await exchangeCode(url.origin, url.searchParams.get('code') ?? '');
  } catch (err) {
    console.error('Google code exchange failed', err);
    return hostPage('Something went wrong', `Google didn't complete the connection. ${retry}, or contact ${CONTACT}.`, false);
  }
  if (conn.missingScopes.length) {
    await revoke(conn.refreshToken);
    return hostPage('Both permissions are needed', `Please tick both calendar boxes on Google's screen: seeing when you're free, and creating the invites we send for you. ${retry}.`, false);
  }

  must(await db().from('dialer_client_calendars').upsert({ airtable_client_id: state.c }, { onConflict: 'airtable_client_id', ignoreDuplicates: true }));
  must(
    await db()
      .from('dialer_calendar_tokens')
      .upsert({ airtable_client_id: state.c, refresh_token_enc: encrypt(conn.refreshToken), scopes: conn.scopes, updated_at: new Date().toISOString() }),
  );
  must(
    await db()
      .from('dialer_client_calendars')
      .update({ status: 'connected', google_email: conn.email, connected_at: new Date().toISOString(), last_error: null })
      .eq('airtable_client_id', state.c),
  );
  return hostPage('Calendar connected', `Thanks${conn.email ? `, ${conn.email}` : ''}. Maronly can now send meeting invites from your calendar. You can close this tab.`, true);
});

export const config: Config = { path: '/api/google/callback', method: 'GET' };
