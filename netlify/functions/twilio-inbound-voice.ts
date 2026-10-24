import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import { db, must } from './_lib/db';
import { handler, twiml, xml } from './_lib/http';
import { routeInbound } from './_lib/routing';
import { callbackUrl, verifyTwilioWebhook } from './_lib/webhook';

const DEFAULT_GREETING = "Hi, sorry we can't take your call right now. Please leave a message after the tone and we'll get back to you.";

/**
 * POST /api/twilio/inbound-voice: the Voice URL on each of our numbers. No live inbound calls: callers hear the
 * number's greeting (a custom recording if one is uploaded) and can leave a voicemail, which is transcribed and
 * shows up in the Inbox of the rep who last called them.
 */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const phone = normalizePhone(p.From);
  const caller = phone.ok ? phone.e164 : null;
  const route = caller ? await routeInbound(caller) : { contact: null, campaign: null, userId: null };

  const number = must(await db().from('dialer_phone_numbers').select('voicemail_greeting_path').eq('e164', p.To).maybeSingle()) as {
    voicemail_greeting_path: string | null;
  } | null;

  const call = must(
    await db()
      .from('dialer_calls')
      .insert({
        direction: 'inbound',
        kind: 'voicemail',
        campaign_id: route.campaign?.id ?? null,
        contact_id: route.contact?.id ?? null,
        user_id: route.userId,
        client_name: route.campaign?.client_name ?? null,
        campaign_name: route.campaign?.name ?? null,
        full_name: route.contact?.full_name ?? null,
        company: route.contact?.company ?? null,
        phone_e164: caller ?? p.From ?? null,
        from_number: p.From ?? null,
        to_number: p.To ?? null,
        twilio_call_sid: p.CallSid,
        twilio_status: 'in-progress',
        // Not a prospect conversation: keep voicemails out of the client's Cold Call Logs.
        visible: false,
      })
      .select('id')
      .single(),
  ) as { id: string };

  let greeting = `<Say voice="Polly.Olivia-Neural" language="en-AU">${xml(DEFAULT_GREETING)}</Say>`;
  if (number?.voicemail_greeting_path) {
    const { data } = await db().storage.from('dialer-greetings').createSignedUrl(number.voicemail_greeting_path, 600);
    if (data?.signedUrl) greeting = `<Play>${xml(data.signedUrl)}</Play>`;
  }

  return twiml(
    `${greeting}<Record maxLength="120" playBeep="true" trim="trim-silence" timeout="5"` +
      ` action="${xml(callbackUrl(req, '/api/twilio/hangup'))}"` +
      ` recordingStatusCallback="${xml(callbackUrl(req, '/api/twilio/recording', { callId: call.id }))}" recordingStatusCallbackEvent="completed"/>`,
  );
});

export const config: Config = { path: '/api/twilio/inbound-voice', method: 'POST' };
