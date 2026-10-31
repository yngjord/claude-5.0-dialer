import type { Config } from '@netlify/functions';
import { normalizeCallable, normalizePhone } from '../../shared/phone';
import { db } from './_lib/db';
import { handler, twiml, xml } from './_lib/http';
import { callbackUrl, verifyTwilioWebhook } from './_lib/webhook';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const say = (text: string) => twiml(`<Say voice="Polly.Olivia-Neural" language="en-AU">${xml(text)}</Say><Hangup/>`);

const REFUSALS: Record<string, string> = {
  user: 'Sorry, your account cannot make calls.',
  oneoff: 'Sorry, only admins can use click to call.',
  contact: 'Sorry, that contact no longer exists.',
  member: "Sorry, you're not assigned to this campaign.",
};

/**
 * POST /api/twilio/voice: the TwiML App's Voice URL. Twilio calls it when a rep's browser starts a call
 * (device.connect with params callId + contactId, or callId + to for an admin's click-to-call) and waits for the
 * answer before dialling, so it does one
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
  // Click-to-call (one-off, no campaign): device.connect sent the number itself (`to`) instead of a contact.
  const oneOff = !p.contactId && !!p.to;
  if (!UUID.test(userId ?? '') || !UUID.test(callId ?? '') || (!oneOff && !UUID.test(p.contactId ?? ''))) return say('Sorry, this call could not be started.');

  let started: { error?: string; from?: string | null; to?: string };
  if (oneOff) {
    const to = normalizeCallable(p.to);
    if (!to.ok) return say('Sorry, this is not an Australian or New Zealand phone number.');
    const { data, error } = await db().rpc('dialer_start_oneoff_call', {
      p_call_id: callId,
      p_user_id: userId,
      p_to: to.e164,
      p_name: p.name ?? '',
      p_company: p.company ?? '',
      p_client_name: p.client ?? '',
      p_twilio_call_sid: p.CallSid,
    });
    if (error) throw new Error(`Supabase: ${error.message}`);
    started = data as typeof started;
    if (started.error === 'user') return say(REFUSALS.oneoff);
  } else {
    const { data, error } = await db().rpc('dialer_start_call', { p_call_id: callId, p_contact_id: p.contactId, p_user_id: userId, p_twilio_call_sid: p.CallSid });
    if (error) throw new Error(`Supabase: ${error.message}`);
    started = data as typeof started;
  }
  if (started.error) return say(REFUSALS[started.error] ?? 'Sorry, this call could not be started.');

  const phone = oneOff ? normalizeCallable(started.to ?? '') : normalizePhone(started.to ?? '');
  if (!phone.ok) return say('Sorry, this number is not an Australian or New Zealand mobile.');
  if (!started.from) return say(oneOff ? 'No click to call number is set up yet. Choose one in Phone numbers.' : 'No caller number is set up for this client. Ask an admin to add one.');

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
