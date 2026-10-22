import type { Config } from '@netlify/functions';
import { handler, twiml } from './_lib/http';
import { verifyTwilioWebhook } from './_lib/twilio';

/** POST /api/twilio/hangup: ends the call after a voicemail has been recorded. */
export default handler(async (req) => {
  await verifyTwilioWebhook(req);
  return twiml('<Hangup/>');
});

export const config: Config = { path: '/api/twilio/hangup', method: 'POST' };
