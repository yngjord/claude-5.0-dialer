import type { Config } from '@netlify/functions';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';

/**
 * GET /api/client-logos: { [Airtable client id]: logo URL } from Clients → Client Logo Image (an attachment), for
 * the clients of the campaigns this user can see (admins: all campaigns; team members: the ones they're assigned to).
 * Airtable's attachment links expire after a couple of hours, so they're fetched fresh rather than stored.
 */

type Attachment = { url: string; thumbnails?: { large?: { url: string } } };
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const rows =
    me.role === 'admin'
      ? (must(await db().from('dialer_campaigns').select('airtable_client_id')) as { airtable_client_id: string }[])
      : (must(await db().from('dialer_campaign_members').select('campaign:dialer_campaigns(airtable_client_id)').eq('user_id', me.userId)) as unknown as {
          campaign: { airtable_client_id: string } | null;
        }[]).flatMap((m) => (m.campaign ? [m.campaign] : []));
  const ids = new Set(rows.map((r) => r.airtable_client_id));
  if (!ids.size) return json({});

  const records = await listAll<{ 'Client Logo Image': Attachment[] }>('Clients', { filterByFormula: "{Client Logo Image} != ''", fields: ['Client Logo Image'] });
  const logos = Object.fromEntries(
    records.flatMap((r) => {
      const file = r.fields['Client Logo Image']?.[0];
      const url = file?.thumbnails?.large?.url ?? file?.url;
      return ids.has(r.id) && url ? [[r.id, url]] : [];
    }),
  );
  return new Response(JSON.stringify(logos), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' } });
});

export const config: Config = { path: '/api/client-logos', method: 'GET' };
