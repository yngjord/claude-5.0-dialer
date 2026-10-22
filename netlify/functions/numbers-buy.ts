import type { Config } from '@netlify/functions';
import { normalizePhone } from '../../shared/phone';
import type { BuyNumberRequest, PhoneNumber } from '../../shared/types';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';
import { findAddress, findBundle } from './_lib/numbers';
import { callbackUrl, requireTwilioConfigured, twilioClient } from './_lib/twilio';

/**
 * POST /api/admin/numbers/buy: buys an AU mobile number on the Twilio account (this costs money every month), points
 * its voicemail and SMS webhooks at this site, and adds it to dialer_phone_numbers for the chosen client. Admins only.
 */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  requireTwilioConfigured();
  const body = await readJson<BuyNumberRequest>(req);
  const phone = normalizePhone(body.phoneNumber);
  if (!phone.ok || phone.country !== 'AU') throw new HttpError(400, 'Choose an Australian mobile number.');
  const clientName = body.clientName?.trim();
  if (!clientName) throw new HttpError(400, 'Choose which client this number is for.');

  const [bundle, addressSid] = await Promise.all([findBundle(), findAddress()]);
  if (!bundle.sid) throw new HttpError(409, `Your Australian regulatory bundle isn't approved yet${bundle.status ? ` (status: ${bundle.status})` : ''}. Numbers can be bought once Twilio approves it.`);
  if (!addressSid) throw new HttpError(409, 'No Australian address is saved on the Twilio account. Add the business address in Twilio (Phone Numbers → Addresses) first.');

  let bought;
  try {
    bought = await twilioClient().incomingPhoneNumbers.create({
      phoneNumber: phone.e164,
      bundleSid: bundle.sid,
      addressSid,
      friendlyName: body.label?.trim() || clientName,
      voiceUrl: callbackUrl(req, '/api/twilio/inbound-voice'),
      voiceMethod: 'POST',
      smsUrl: callbackUrl(req, '/api/twilio/inbound-sms'),
      smsMethod: 'POST',
    });
  } catch (err) {
    console.error('Twilio number purchase failed', phone.e164, err);
    throw new HttpError(502, `Twilio couldn't buy that number: ${(err as Error).message}. It may have just been taken; search again.`);
  }

  const row = must(
    await db()
      .from('dialer_phone_numbers')
      .upsert({ e164: bought.phoneNumber, twilio_sid: bought.sid, label: body.label?.trim() || null, client_name: clientName }, { onConflict: 'e164' })
      .select('*')
      .single(),
  ) as PhoneNumber;
  return json(row);
});

export const config: Config = { path: '/api/admin/numbers/buy', method: 'POST' };
