import type { Config } from '@netlify/functions';
import { requireDialerUser } from './_lib/auth';
import { syncClientLogos } from './_lib/clientLogos';
import { handler, json } from './_lib/http';

/**
 * POST /api/client-logos: copies any new or changed client logos from Airtable into our storage and returns
 * { Airtable client id: logo URL }. The app normally reads the copies straight from the database; it calls this when
 * there are none yet. The sweep also runs it every 10 minutes, so a logo changed in Airtable shows up on its own.
 */
export default handler(async (req) => {
  await requireDialerUser(req);
  return json(await syncClientLogos());
});

export const config: Config = { path: '/api/client-logos', method: 'POST' };
