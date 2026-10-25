import type { Me } from '../../../shared/types';
import { db, must } from './db';

/**
 * The Airtable client ids a team member is assigned to: the clients of the (non-draft) campaigns they're on. Null for
 * admins, who can use every client.
 */
export async function assignedClientIds(me: Me): Promise<Set<string> | null> {
  if (me.role === 'admin') return null;
  const rows = must(
    await db().from('dialer_campaign_members').select('campaign:dialer_campaigns!inner(airtable_client_id, status)').eq('user_id', me.userId).neq('campaign.status', 'draft'),
  ) as unknown as { campaign: { airtable_client_id: string } | null }[];
  return new Set(rows.map((r) => r.campaign?.airtable_client_id).filter((id): id is string => !!id));
}
