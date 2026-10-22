import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { callbackUrl, twilioClient } from './_lib/twilio';

/**
 * POST /api/admin/numbers-sync: imports every number on the Twilio account into phone_numbers and points its
 * voice and SMS webhooks at this site (voicemail + inbound texts). Run it after buying a number.
 */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  const client = twilioClient();
  const numbers = await client.incomingPhoneNumbers.list({ limit: 200 });
  const voiceUrl = callbackUrl(req, '/api/twilio/inbound-voice');
  const smsUrl = callbackUrl(req, '/api/twilio/inbound-sms');

  for (const n of numbers) {
    await client.incomingPhoneNumbers(n.sid).update({ voiceUrl, voiceMethod: 'POST', smsUrl, smsMethod: 'POST' });
    const existing = must(await db().from('phone_numbers').select('id').eq('e164', n.phoneNumber).maybeSingle());
    if (existing) must(await db().from('phone_numbers').update({ twilio_sid: n.sid }).eq('e164', n.phoneNumber));
    else must(await db().from('phone_numbers').insert({ e164: n.phoneNumber, twilio_sid: n.sid, label: n.friendlyName }));
  }
  return json({ synced: numbers.length });
});

export const config: Config = { path: '/api/admin/numbers-sync', method: 'POST' };
