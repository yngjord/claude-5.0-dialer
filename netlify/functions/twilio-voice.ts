import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import { db } from './_lib/db';
import { handler, twiml, xml } from './_lib/http';
import { callbackUrl, verifyTwilioWebhook } from './_lib/webhook';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const say = (text: string) => twiml(`<Say voice="Polly.Olivia-Neural" language="en-AU">${xml(text)}</Say><Hangup/>`);

const REFUSALS: Record<string, string> = {
  user: 'Sorry, your account cannot make calls.',
  contact: 'Sorry, that contact no longer exists.',
  member: "Sorry, you're not assigned to this campaign.",
};

/**
 * POST /api/twilio/voice: the TwiML App's Voice URL. Twilio calls it when a rep's browser starts a call
 * (device.connect with params callId + contactId) and waits for the answer before dialling, so it does one
 * database round trip (dialer_start_call: checks the rep may call this contact, picks the caller number and logs
 * the call) and doesn't load the Twilio SDK.
 *
 * The rep hears the line the whole time (answerOnBridge), so AMD only labels the call. It never delays or drops
 * the audio, which keeps us clear of abandoned-call problems.
 */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const userId = p.From?.replace(/^client:/, '');
  const callId = p.callId;
  if (!UUID.test(userId ?? '') || !UUID.test(callId ?? '') || !UUID.test(p.contactId ?? '')) return say('Sorry, this call could not be started.');

  const { data, error } = await db().rpc('dialer_start_call', { p_call_id: callId, p_contact_id: p.contactId, p_user_id: userId, p_twilio_call_sid: p.CallSid });
  if (error) throw new Error(`Supabase: ${error.message}`);
  const started = data as { error?: string; from?: string | null; to?: string };
  if (started.error) return say(REFUSALS[started.error] ?? 'Sorry, this call could not be started.');

  const phone = normalizePhone(started.to ?? '');
  if (!phone.ok) return say('Sorry, this number is not an Australian or New Zealand mobile.');
  if (!started.from) return say('No caller number is set up for this client. Ask an admin to add one.');

  const q = { callId: callId! };
  return twiml(
    `<Dial callerId="${xml(started.from)}" answerOnBridge="true" timeout="30" record="record-from-answer-dual"` +
      ` recordingStatusCallback="${xml(callbackUrl(req, '/api/twilio/recording', q))}" recordingStatusCallbackEvent="completed">` +
      `<Number machineDetection="Enable" amdStatusCallback="${xml(callbackUrl(req, '/api/twilio/amd', q))}"` +
      ` statusCallback="${xml(callbackUrl(req, '/api/twilio/call-status', q))}" statusCallbackEvent="initiated ringing answered completed">` +
      `${xml(phone.e164)}</Number></Dial>`,
  );
});

export const config: Config = { path: '/api/twilio/voice', method: 'POST' };
