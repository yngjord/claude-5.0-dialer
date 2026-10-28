import type { Config } from '@netlify/functions';
import type { TwilioBalance } from '../../shared/types';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';
import { requireTwilioConfigured, twilioClient } from './_lib/twilio';

/** GET /api/admin/twilio-balance: the Twilio account's prepaid balance, for the admin sidebar. */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  requireTwilioConfigured();
  const b = await twilioClient().balance.fetch();
  return json({ balance: Number(b.balance), currency: b.currency } satisfies TwilioBalance);
});

export const config: Config = { path: '/api/admin/twilio-balance', method: 'GET' };
