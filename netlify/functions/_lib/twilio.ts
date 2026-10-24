import twilio from 'twilio';
import { env, HttpError } from './http';

let client: ReturnType<typeof twilio> | null = null;

/** Refuses with a clear message (rather than a generic 500) while Twilio's keys aren't in Netlify yet. */
export function requireTwilioConfigured(): void {
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new HttpError(503, `Twilio isn't connected yet. Add ${missing.join(', ')} to Netlify's environment variables.`);
}

/** Twilio REST client, authenticated with the API key (not the account's auth token). */
export function twilioClient() {
  client ??= twilio(env('TWILIO_API_KEY_SID'), env('TWILIO_API_KEY_SECRET'), { accountSid: env('TWILIO_ACCOUNT_SID') });
  return client;
}

/** Basic auth header for fetching Twilio media (recordings) directly. */
export function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(`${env('TWILIO_API_KEY_SID')}:${env('TWILIO_API_KEY_SECRET')}`).toString('base64')}`;
}

export { callbackUrl, verifyTwilioWebhook } from './webhook';

/**
 * The number a campaign calls and texts from: the one picked on the campaign, else its client's number, else the
 * default. Numbers belong to clients, and every rep on that client's campaigns shares it.
 */
export async function pickCallerNumber(
  dbClient: import('@supabase/supabase-js').SupabaseClient,
  campaign: { caller_number_id: string | null; client_name: string } | null,
): Promise<string | null> {
  const { data } = await dbClient.from('dialer_phone_numbers').select('id, e164, client_name, is_default').order('created_at');
  const numbers = (data ?? []) as { id: string; e164: string; client_name: string | null; is_default: boolean }[];
  return (
    (campaign && numbers.find((n) => n.id === campaign.caller_number_id)?.e164) ??
    (campaign && numbers.find((n) => n.client_name === campaign.client_name)?.e164) ??
    numbers.find((n) => n.is_default)?.e164 ??
    null
  );
}
