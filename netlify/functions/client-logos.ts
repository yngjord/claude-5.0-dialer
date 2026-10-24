import type { Config } from '@netlify/functions';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';

/**
 * GET /api/client-logos: { [Airtable client id]: logo URL } from Clients → Logo URL, for the clients of the
 * campaigns this user can see (admins: all campaigns; team members: the ones they're assigned to).
 */
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

  const records = await listAll<{ 'Logo URL': string }>('Clients', { filterByFormula: "{Logo URL} != ''", fields: ['Logo URL'] });
  const logos = Object.fromEntries(records.filter((r) => ids.has(r.id) && /^https?:\/\//i.test(r.fields['Logo URL']?.trim() ?? '')).map((r) => [r.id, r.fields['Logo URL']!.trim()]));
  return new Response(JSON.stringify(logos), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' } });
});

export const config: Config = { path: '/api/client-logos', method: 'GET' };
