import type { Config } from '@netlify/functions';
import type { AirtableClient } from '../../shared/types';
import { listAll } from './_lib/airtable';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';

/** GET /api/clients: Airtable Clients, for linking a campaign to a client (admins). */
export default handler(async (req) => {
  requireAdmin(await requireDialerUser(req));
  const records = await listAll<{ 'Client Company': string; Status: string }>('Clients', {
    filterByFormula: "{Client Company} != ''",
    fields: ['Client Company', 'Status'],
  });
  const clients: AirtableClient[] = records
    .map((r) => ({ id: r.id, name: r.fields['Client Company']!.trim(), status: r.fields.Status ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(clients);
});

export const config: Config = { path: '/api/clients', method: 'GET' };
