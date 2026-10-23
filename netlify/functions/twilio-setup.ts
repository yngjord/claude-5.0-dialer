import type { Config } from '@netlify/functions';
import type { TwilioStatus } from '../../shared/types';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';
import { requireTwilioConfigured, twilioClient } from './_lib/twilio';
import { runTwilioSetup } from './_lib/twilioSetup';

const isSet = (name: string) => !!process.env[name];

/**
 * GET /api/admin/twilio-setup: which Twilio settings Netlify has (yes/no only, never the values).
 * POST /api/admin/twilio-setup: runs the one-off Twilio setup against this site's address and returns the two SIDs
 * to add to Netlify. Admins only. Run it from the live site address, since Twilio's webhooks will point there.
 */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));

  if (req.method === 'GET') {
    return json({
      keys: isSet('TWILIO_ACCOUNT_SID') && isSet('TWILIO_API_KEY_SID') && isSet('TWILIO_API_KEY_SECRET'),
      authToken: isSet('TWILIO_AUTH_TOKEN'),
      twimlApp: isSet('TWILIO_TWIML_APP_SID'),
      intelligence: isSet('TWILIO_INTELLIGENCE_SERVICE_SID'),
      siteUrl: process.env.PUBLIC_BASE_URL || new URL(req.url).origin,
    } satisfies TwilioStatus);
  }

  requireTwilioConfigured();
  const base = process.env.PUBLIC_BASE_URL || new URL(req.url).origin;
  return json(await runTwilioSetup(twilioClient(), base));
});

export const config: Config = { path: '/api/admin/twilio-setup', method: ['GET', 'POST'] };
