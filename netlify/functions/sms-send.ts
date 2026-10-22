import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import type { SmsMessage, SmsSendRequest } from '../../shared/types';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';
import { callbackUrl, pickCallerNumber, twilioClient } from './_lib/twilio';

/**
 * POST /api/sms: sends a text from the client's number (or the number the conversation is already on). Reps can text contacts in their campaigns, and anyone who
 * has texted or been texted by them; admins can text any AU/NZ mobile.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const body = await readJson<SmsSendRequest>(req);
  const text = body.body?.trim() ?? '';
  if (!text) throw new HttpError(400, 'Type a message.');
  if (text.length > 1600) throw new HttpError(400, 'Messages are limited to 1600 characters.');
  const phone = normalizePhone(body.to);
  if (!phone.ok) throw new HttpError(400, phone.reason);

  const contacts = must(await db().from('dialer_contacts').select('id, campaign_id').eq('phone_e164', phone.e164)) as { id: string; campaign_id: string }[];
  let allowed = me.role === 'admin';
  let campaignIds = contacts.map((c) => c.campaign_id);
  if (!allowed && campaignIds.length) {
    const mine = must(await db().from('dialer_campaign_members').select('campaign_id').eq('user_id', me.userId).in('campaign_id', campaignIds)) as { campaign_id: string }[];
    campaignIds = mine.map((m) => m.campaign_id);
    allowed = campaignIds.length > 0;
  }
  if (!allowed) {
    const thread = must(await db().from('dialer_sms_messages').select('id').eq('phone_e164', phone.e164).eq('user_id', me.userId).limit(1));
    allowed = (thread as unknown[]).length > 0;
  }
  if (!allowed) throw new HttpError(403, "You can only text contacts in your campaigns.");

  const contact = contacts.find((c) => c.id === body.contactId) ?? contacts.find((c) => campaignIds.includes(c.campaign_id)) ?? null;
  // Keep a conversation on one number: reply from whichever of our numbers last texted with this person.
  const last = must(
    await db().from('dialer_sms_messages').select('our_number').eq('phone_e164', phone.e164).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ) as { our_number: string } | null;
  const ours = last && must(await db().from('dialer_phone_numbers').select('e164').eq('e164', last.our_number).maybeSingle());
  const campaign = contact
    ? ((await db().from('dialer_campaigns').select('caller_number_id, client_name').eq('id', contact.campaign_id).maybeSingle()).data as {
        caller_number_id: string | null;
        client_name: string;
      } | null)
    : null;
  const from = ours ? last.our_number : await pickCallerNumber(db(), campaign);
  if (!from) throw new HttpError(400, "No number is set up for this client. Ask an admin to add one.");

  const msg = await twilioClient().messages.create({ to: phone.e164, from, body: text, statusCallback: callbackUrl(req, '/api/twilio/sms-status') });
  const row = must(
    await db()
      .from('dialer_sms_messages')
      .insert({
        direction: 'outbound',
        contact_id: contact?.id ?? null,
        user_id: me.userId,
        phone_e164: phone.e164,
        our_number: from,
        body: text,
        twilio_sid: msg.sid,
        status: msg.status,
        read_at: new Date().toISOString(),
      })
      .select('*')
      .single(),
  ) as SmsMessage;
  return json(row);
});

export const config: Config = { path: '/api/sms', method: 'POST' };
