import twilio from 'twilio';
import { env, HttpError } from './http';

let client: ReturnType<typeof twilio> | null = null;

/** Twilio REST client, authenticated with the API key (not the account's auth token). */
export function twilioClient() {
  client ??= twilio(env('TWILIO_API_KEY_SID'), env('TWILIO_API_KEY_SECRET'), { accountSid: env('TWILIO_ACCOUNT_SID') });
  return client;
}

/** Basic auth header for fetching Twilio media (recordings) directly. */
export function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(`${env('TWILIO_API_KEY_SID')}:${env('TWILIO_API_KEY_SECRET')}`).toString('base64')}`;
}

/**
 * Reads a Twilio webhook's form body and checks its X-Twilio-Signature, so nobody else can post fake call events.
 * Twilio signs the exact public URL it requested; PUBLIC_BASE_URL covers proxies/tunnels that rewrite the host.
 */
export async function verifyTwilioWebhook(req: Request): Promise<Record<string, string>> {
  const params = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
  const signature = req.headers.get('x-twilio-signature') ?? '';
  const url = new URL(req.url);
  const candidates = [url.toString(), url.toString().replace(/^http:/, 'https:')];
  if (process.env.PUBLIC_BASE_URL) candidates.push(`${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${url.pathname}${url.search}`);

  const authToken = env('TWILIO_AUTH_TOKEN');
  if (!signature || !candidates.some((u) => twilio.validateRequest(authToken, signature, u, params))) {
    console.warn('Rejected Twilio webhook with a bad signature', url.pathname);
    throw new HttpError(403, 'Invalid signature');
  }
  return params;
}

/** Absolute URL for a Twilio callback on this site (same origin as the incoming request). */
export function callbackUrl(req: Request, path: string, query: Record<string, string> = {}): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || new URL(req.url).origin;
  const qs = new URLSearchParams(query).toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

/** The caller id for a rep: their own number, else the campaign's, else the default number. */
export async function pickCallerNumber(
  dbClient: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  campaignNumberId: string | null,
): Promise<string | null> {
  const { data } = await dbClient.from('phone_numbers').select('id, e164, assigned_user_id, is_default');
  const numbers = (data ?? []) as { id: string; e164: string; assigned_user_id: string | null; is_default: boolean }[];
  return (
    numbers.find((n) => n.assigned_user_id === userId)?.e164 ??
    numbers.find((n) => n.id === campaignNumberId)?.e164 ??
    numbers.find((n) => n.is_default)?.e164 ??
    null
  );
}
