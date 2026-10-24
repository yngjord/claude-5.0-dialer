import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { verifyTwilioWebhook } from './_lib/webhook';

/** POST /api/twilio/sms-status: delivery updates for texts we sent (sent, delivered, undelivered, failed). */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  if (p.MessageSid) {
    must(
      await db()
        .from('dialer_sms_messages')
        .update({ status: p.MessageStatus, error: p.ErrorCode ? `Error ${p.ErrorCode}` : null })
        .eq('twilio_sid', p.MessageSid),
    );
  }
  return json({ ok: true });
});

export const config: Config = { path: '/api/twilio/sms-status', method: 'POST' };
