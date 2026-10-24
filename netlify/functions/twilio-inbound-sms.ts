import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import { db, must } from './_lib/db';
import { handler, twiml } from './_lib/http';
import { routeInbound } from './_lib/routing';
import { verifyTwilioWebhook } from './_lib/webhook';

/** POST /api/twilio/inbound-sms: the Messaging URL on each of our numbers. Saves the text; no auto-reply. */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const phone = normalizePhone(p.From);
  const from = phone.ok ? phone.e164 : p.From;
  const route = phone.ok ? await routeInbound(phone.e164) : { contact: null, userId: null };

  must(
    await db()
      .from('dialer_sms_messages')
      .upsert(
        {
          direction: 'inbound',
          contact_id: route.contact?.id ?? null,
          user_id: route.userId,
          phone_e164: from,
          our_number: p.To,
          body: p.Body ?? '',
          twilio_sid: p.MessageSid,
          status: 'received',
        },
        { onConflict: 'twilio_sid', ignoreDuplicates: true },
      ),
  );
  return twiml('');
});

export const config: Config = { path: '/api/twilio/inbound-sms', method: 'POST' };
