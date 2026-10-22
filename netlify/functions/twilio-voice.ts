import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import type { Campaign, Contact } from '../../shared/types';
import { loadDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, twiml, xml } from './_lib/http';
import { callbackUrl, pickCallerNumber, verifyTwilioWebhook } from './_lib/twilio';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const say = (text: string) => twiml(`<Say voice="Polly.Olivia-Neural" language="en-AU">${xml(text)}</Say><Hangup/>`);

/**
 * POST /api/twilio/voice: the TwiML App's Voice URL. Twilio calls it when a rep's browser starts a call
 * (device.connect with params callId + contactId). Checks the rep may call this contact, logs the call, and
 * dials the prospect with recording and answering machine detection.
 *
 * The rep hears the line the whole time (answerOnBridge), so AMD only labels the call. It never delays or drops
 * the audio, which keeps us clear of abandoned-call problems.
 */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const userId = p.From?.replace(/^client:/, '');
  const callId = p.callId;
  if (!userId || !UUID.test(callId ?? '') || !UUID.test(p.contactId ?? '')) return say('Sorry, this call could not be started.');

  let me;
  try {
    me = await loadDialerUser(userId);
  } catch (err) {
    if (err instanceof HttpError) return say('Sorry, your account cannot make calls.');
    throw err;
  }

  const contact = must(await db().from('dialer_contacts').select('*').eq('id', p.contactId).maybeSingle()) as Contact | null;
  if (!contact) return say('Sorry, that contact no longer exists.');
  const campaign = must(await db().from('dialer_campaigns').select('*').eq('id', contact.campaign_id).single()) as Campaign;

  if (me.role !== 'admin') {
    const member = must(await db().from('dialer_campaign_members').select('user_id').eq('campaign_id', campaign.id).eq('user_id', me.userId).maybeSingle());
    if (!member) return say("Sorry, you're not assigned to this campaign.");
  }

  const phone = normalizePhone(contact.phone_e164);
  const from = await pickCallerNumber(db(), campaign);

  must(
    await db().from('dialer_calls').insert({
      id: callId,
      direction: 'outbound',
      campaign_id: campaign.id,
      contact_id: contact.id,
      user_id: me.userId,
      agent_name: me.displayName,
      client_name: campaign.client_name,
      campaign_name: campaign.name,
      full_name: contact.full_name,
      email: contact.email,
      company: contact.company,
      linkedin: contact.linkedin,
      website: contact.website,
      phone_e164: contact.phone_e164,
      from_number: from,
      to_number: contact.phone_e164,
      twilio_call_sid: p.CallSid,
      twilio_status: phone.ok && from ? 'initiated' : 'failed',
    }),
  );

  if (!phone.ok) return say('Sorry, this number is not an Australian or New Zealand mobile.');
  if (!from) return say("No caller number is set up for this client. Ask an admin to add one.");

  const q = { callId };
  return twiml(
    `<Dial callerId="${xml(from)}" answerOnBridge="true" timeout="30" record="record-from-answer-dual"` +
      ` recordingStatusCallback="${xml(callbackUrl(req, '/api/twilio/recording', q))}" recordingStatusCallbackEvent="completed">` +
      `<Number machineDetection="Enable" amdStatusCallback="${xml(callbackUrl(req, '/api/twilio/amd', q))}"` +
      ` statusCallback="${xml(callbackUrl(req, '/api/twilio/call-status', q))}" statusCallbackEvent="initiated ringing answered completed">` +
      `${xml(phone.e164)}</Number></Dial>`,
  );
});

export const config: Config = { path: '/api/twilio/voice', method: 'POST' };
