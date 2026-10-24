import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, HttpError } from './http';

// Kept apart from ./twilio so webhook handlers don't load the Twilio SDK (it's large and slows cold starts).

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the URL followed by each form param (sorted by name) as name+value. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
  if (!signature || !candidates.some((u) => sameSignature(twilioSignature(authToken, u, params), signature))) {
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
