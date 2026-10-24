import type { Config } from '@netlify/functions';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { handler } from './_lib/http';

/**
 * GET /api/client-logos: { [Airtable client id]: logo URL } from Clients → Client Logo Image (an attachment), for
 * every client with a logo, so a campaign created after the page loaded still has its logo. Logos aren't sensitive.
 * Airtable's attachment links expire after a couple of hours, so they're fetched fresh rather than stored.
 */

type Attachment = { url: string; thumbnails?: { large?: { url: string } } };

export default handler(async (req) => {
  await requireDialerUser(req);
  const records = await listAll<{ 'Client Logo Image': Attachment[] }>('Clients', { filterByFormula: "{Client Logo Image} != ''", fields: ['Client Logo Image'] });
  const logos = Object.fromEntries(
    records.flatMap((r) => {
      const file = r.fields['Client Logo Image']?.[0];
      const url = file?.thumbnails?.large?.url ?? file?.url;
      return url ? [[r.id, url]] : [];
    }),
  );
  return new Response(JSON.stringify(logos), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' } });
});

export const config: Config = { path: '/api/client-logos', method: 'GET' };
