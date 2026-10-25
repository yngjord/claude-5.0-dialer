import type { Me } from '../../../shared/types';
import { db, must } from './db';

export interface AssignedClients {
  /** Airtable Clients record ids, from the (non-draft) campaigns they're on. */
  ids: Set<string>;
  /** Lower-cased Client Company names, from their profile's client_names (as set for the portal). */
  names: Set<string>;
}

/**
 * The clients a team member is assigned to: those named in their profile's client_names, plus the clients of the
 * campaigns they're on. Null for admins, who can use every client.
 */
export async function assignedClients(me: Me): Promise<AssignedClients | null> {
  if (me.role === 'admin') return null;
  const [profile, members] = await Promise.all([
    db().from('profiles').select('client_names').eq('id', me.userId).maybeSingle(),
    db().from('dialer_campaign_members').select('campaign:dialer_campaigns!inner(airtable_client_id, status)').eq('user_id', me.userId).neq('campaign.status', 'draft'),
  ]);
  const names = ((must(profile) as { client_names: string[] | null } | null)?.client_names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const rows = must(members) as unknown as { campaign: { airtable_client_id: string } | null }[];
  return {
    ids: new Set(rows.map((r) => r.campaign?.airtable_client_id).filter((id): id is string => !!id)),
    names: new Set(names),
  };
}

export function isAssigned(assigned: AssignedClients | null, client: { id: string; name: string }): boolean {
  return !assigned || assigned.ids.has(client.id) || assigned.names.has(client.name.trim().toLowerCase());
}
