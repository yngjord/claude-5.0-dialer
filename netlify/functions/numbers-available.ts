import type { Config } from '@netlify/functions';
import type { AvailableNumbersResponse } from '../../shared/types';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';
import { COUNTRY, findBundle, mobileMonthlyPrice } from './_lib/numbers';
import { requireTwilioConfigured, twilioClient } from './_lib/twilio';

/**
 * GET /api/admin/numbers/available?contains=412: AU mobile numbers (voice + SMS) Twilio has for sale, the monthly
 * price, and whether the account's regulatory bundle is approved (needed before buying). Admins only.
 */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  requireTwilioConfigured();
  const contains = new URL(req.url).searchParams.get('contains')?.replace(/\D/g, '') ?? '';

  const [found, price, bundle] = await Promise.all([
    twilioClient()
      .availablePhoneNumbers(COUNTRY)
      .mobile.list({ voiceEnabled: true, smsEnabled: true, limit: 20, ...(contains ? { contains: contains.replace(/^0/, '') } : {}) }),
    mobileMonthlyPrice(),
    findBundle(),
  ]);

  return json({
    numbers: found.map((n) => ({ phoneNumber: n.phoneNumber, locality: n.locality || null, region: n.region || null, sms: n.capabilities.sms, voice: n.capabilities.voice })),
    price,
    bundleReady: !!bundle.sid,
    bundleStatus: bundle.status,
  } satisfies AvailableNumbersResponse);
});

export const config: Config = { path: '/api/admin/numbers/available', method: 'GET' };
