import type { Config } from '@netlify/functions';
import twilio from 'twilio';
import { requireDialerUser } from './_lib/auth';
import { env, handler, json } from './_lib/http';

const TTL_SECONDS = 3600;

/**
 * GET /api/voice-token: a Twilio Access Token for the browser's Voice SDK. Outbound calls only; the identity is
 * the Supabase user id, which /api/twilio/voice uses to know who is calling.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(env('TWILIO_ACCOUNT_SID'), env('TWILIO_API_KEY_SID'), env('TWILIO_API_KEY_SECRET'), {
    identity: me.userId,
    ttl: TTL_SECONDS,
  });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env('TWILIO_TWIML_APP_SID'), incomingAllow: false }));
  return json({ token: token.toJwt(), ttl: TTL_SECONDS });
});

export const config: Config = { path: '/api/voice-token', method: 'GET' };
