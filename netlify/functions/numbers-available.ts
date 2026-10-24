import type { Config } from '@netlify/functions';
import { matchesNumberSearch, NUMBER_MATCHES, numberSearchPattern, type NumberMatch } from '../../shared/numberSearch';
import type { AvailableNumbersResponse } from '../../shared/types';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { handler, HttpError, json } from './_lib/http';
import { COUNTRY, findBundle, mobileMonthlyPrice } from './_lib/numbers';
import { requireTwilioConfigured, twilioClient } from './_lib/twilio';

/**
 * GET /api/admin/numbers/available?digits=888&match=end: AU mobile numbers (voice + SMS) Twilio has for sale, the monthly
 * price, and whether the account's regulatory bundle is approved (needed before buying). `match` is anywhere (default),
 * start or end. Admins only.
 */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  requireTwilioConfigured();
  const params = new URL(req.url).searchParams;
  const match = (NUMBER_MATCHES as readonly string[]).includes(params.get('match') ?? '') ? (params.get('match') as NumberMatch) : 'anywhere';
  const pattern = numberSearchPattern(params.get('digits') ?? '', match);
  if (!pattern.ok) throw new HttpError(400, pattern.reason);

  const [found, price, bundle] = await Promise.all([
    twilioClient()
      .availablePhoneNumbers(COUNTRY)
      // Twilio matches the digits anywhere, so fetch plenty and keep the true start/end matches below.
      .mobile.list({ voiceEnabled: true, smsEnabled: true, limit: pattern.contains && match !== 'anywhere' ? 200 : 20, ...(pattern.contains ? { contains: pattern.contains } : {}) }),
    mobileMonthlyPrice(),
    findBundle(),
  ]);

  return json({
    numbers: found
      .filter((n) => matchesNumberSearch(n.phoneNumber, pattern.digits, match))
      .slice(0, 20)
      .map((n) => ({ phoneNumber: n.phoneNumber, locality: n.locality || null, region: n.region || null, sms: n.capabilities.sms, voice: n.capabilities.voice })),
    price,
    bundleReady: !!bundle.sid,
    bundleStatus: bundle.status,
  } satisfies AvailableNumbersResponse);
});

export const config: Config = { path: '/api/admin/numbers/available', method: 'GET' };
