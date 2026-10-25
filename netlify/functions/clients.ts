import type { Config } from '@netlify/functions';
import type { AirtableClient } from '../../shared/types';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';

/** GET /api/clients: active Airtable Clients, for linking a campaign, phone number or hand-added lead to a client. */
export default handler(async (req) => {
  await requireDialerUser(req);
  const records = await listAll<{ 'Client Company': string; Status: string }>('Clients', {
    filterByFormula: "AND({Client Company} != '', {Status} = 'Active')",
    fields: ['Client Company', 'Status'],
  });
  const clients: AirtableClient[] = records
    .map((r) => ({ id: r.id, name: r.fields['Client Company']!.trim(), status: r.fields.Status ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(clients);
});

export const config: Config = { path: '/api/clients', method: 'GET' };
