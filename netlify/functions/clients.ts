import type { Config } from '@netlify/functions';
import type { AirtableClient } from '../../shared/types';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { assignedClients, isAssigned } from './_lib/clients';
import { handler, json } from './_lib/http';

/**
 * GET /api/clients: active Airtable Clients, for linking a campaign, phone number or hand-added lead to a client.
 * Team members only get the clients they're assigned to (profile client_names, or their campaigns); admins get them all.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const [records, assigned] = await Promise.all([
    listAll<{ 'Client Company': string; Status: string }>('Clients', {
      filterByFormula: "AND({Client Company} != '', {Status} = 'Active')",
      fields: ['Client Company', 'Status'],
    }),
    assignedClients(me),
  ]);
  const clients: AirtableClient[] = records
    .map((r) => ({ id: r.id, name: r.fields['Client Company']!.trim(), status: r.fields.Status ?? null }))
    .filter((c) => isAssigned(assigned, c))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(clients);
});

export const config: Config = { path: '/api/clients', method: 'GET' };
