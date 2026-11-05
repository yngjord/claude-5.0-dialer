import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, must } from './db';
import { env, HttpError } from './http';

/**
 * Google Calendar for a client's host (e.g. their founder): they connect their own calendar with OAuth from a link
 * an admin sends them. We ask for free/busy and for events on calendars they own (to create the invites the client
 * asked for), plus their email address so admins can see which account connected. Nothing else.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
] as const;
/** The two calendar scopes have to be granted (Google lets people untick them). */
const REQUIRED_SCOPES = GOOGLE_SCOPES.slice(2);

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ── Encryption (refresh tokens at rest) and signing (connect links, OAuth state) ─────────────────────────────────

function key(): Buffer {
  const k = Buffer.from(env('GOOGLE_TOKEN_KEY'), 'base64');
  if (k.length !== 32) throw new Error('GOOGLE_TOKEN_KEY must be 32 random bytes, base64-encoded.');
  return k;
}
/** A separate key for signing, derived from the same secret, so signatures and ciphertexts never share a key. */
const signingKey = () => createHmac('sha256', key()).update('maronly-dialer:signing').digest();

/** AES-256-GCM: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable stored token.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** A tamper-proof, expiring token carrying `data`: "<payload>.<signature>" (base64url). */
export function sign(data: Record<string, unknown>, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${createHmac('sha256', signingKey()).update(payload).digest('base64url')}`;
}

/** The data from a `sign`ed token, or null if it was altered or has expired. */
export function verify<T extends Record<string, unknown>>(token: string | null): T | null {
  const [payload, sig] = (token ?? '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', signingKey()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T & { exp: number };
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

// ── OAuth ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const redirectUri = (origin: string) => `${origin}/api/google/callback`;

/** Google's consent screen. `prompt=consent` so Google always returns a refresh token (also on reconnect). */
export function authUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env('GOOGLE_OAUTH_CLIENT_ID'),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_OAUTH_CLIENT_ID'), client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET'), ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Google token request failed (${res.status})`) as Error & { code?: string };
    err.code = data.error;
    throw err;
  }
  return data;
}

export interface Connection {
  refreshToken: string;
  scopes: string;
  email: string | null;
  missingScopes: string[];
}

/** Swaps the code from Google's redirect for the host's tokens. */
export async function exchangeCode(origin: string, code: string): Promise<Connection> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin) });
  const granted = (t.scope ?? '').split(' ');
  // The id token came straight from Google over TLS, so its claims can be read without checking the signature.
  let email: string | null = null;
  try {
    email = (JSON.parse(Buffer.from((t.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string }).email ?? null;
  } catch {
    // no email: still usable
  }
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Please try connecting again.');
  return { refreshToken: t.refresh_token, scopes: granted.join(' '), email, missingScopes: REQUIRED_SCOPES.filter((s) => !granted.includes(s)) };
}

/** Tells Google to cancel the host's grant (best effort: we forget the token either way). */
export async function revoke(refreshToken: string): Promise<void> {
  await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }) }).catch(
    () => undefined,
  );
}

/**
 * A short-lived access token for the client's connected calendar. If Google refuses the stored token (the host
 * disconnected, or it was revoked), the connection is marked disconnected so admins see it and can send a new link.
 */
export async function calendarAccessToken(airtableClientId: string): Promise<string> {
  const row = must(await db().from('dialer_calendar_tokens').select('refresh_token_enc').eq('airtable_client_id', airtableClientId).maybeSingle()) as {
    refresh_token_enc: string;
  } | null;
  if (!row) throw new HttpError(409, "This client's Google Calendar isn't connected.");
  try {
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc) })).access_token;
  } catch (err) {
    if ((err as { code?: string }).code === 'invalid_grant') {
      await db().from('dialer_calendar_tokens').delete().eq('airtable_client_id', airtableClientId);
      await db()
        .from('dialer_client_calendars')
        .update({ status: 'disconnected', last_error: 'Google access was removed. Send the host a new connect link.' })
        .eq('airtable_client_id', airtableClientId);
      throw new HttpError(409, "The client's Google Calendar was disconnected. An admin needs to send a new connect link.");
    }
    throw err;
  }
}

// ── Invites ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface InviteEvent {
  /** Google event id: lowercase a–v and 0–9. One per call, so a retry can't send a second invite. */
  id: string;
  summary: string;
  description: string;
  start: Date;
  minutes: number;
  timeZone: string;
  guests: string[];
  /** The host (the connected account), listed first and already accepted, as Google does for events made by hand. */
  hostEmail?: string | null;
}

/** The event id for a call's invite ("md" + the call id's hex digits, which Google accepts). */
export const inviteEventId = (callId: string) => `md${callId.replace(/-/g, '').toLowerCase()}`;

/**
 * Creates the meeting on the host's primary calendar with a Google Meet link, and has Google email the guests.
 * Returns false if this invite was already created (same event id), so retries are safe.
 */
export async function createInvite(accessToken: string, e: InviteEvent): Promise<{ created: boolean; htmlLink?: string }> {
  const end = new Date(e.start.getTime() + e.minutes * 60_000);
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: e.id,
      summary: e.summary,
      description: e.description || undefined,
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: end.toISOString(), timeZone: e.timeZone },
      attendees: [
        ...(e.hostEmail ? [{ email: e.hostEmail, organizer: true, responseStatus: 'accepted' }] : []),
        ...e.guests.filter((g) => g.toLowerCase() !== e.hostEmail?.toLowerCase()).map((email) => ({ email })),
      ],
      conferenceData: { createRequest: { requestId: e.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
    }),
  });
  if (res.status === 409) return { created: false };
  const data = (await res.json().catch(() => ({}))) as { htmlLink?: string; error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, `Google Calendar: ${data.error?.message ?? res.statusText}`);
  return { created: true, htmlLink: data.htmlLink };
}

/** Who hosts should contact about their connection. */
export const CONTACT = 'Jordan Maroni at <a href="mailto:jordan@maronly.com">jordan@maronly.com</a>';

/** A small standalone page for the host's browser (connect results). */
export function hostPage(title: string, body: string, ok: boolean): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fd;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;padding:16px}
.card{max-width:440px;background:#fff;border-radius:25px;padding:32px;box-shadow:0 10px 30px rgba(36,100,215,.12);text-align:center}
.dot{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:28px;color:#fff;background:${ok ? '#16a34a' : '#d97706'}}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4b5563}a{color:#2464d7}</style></head>
<body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${body}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
