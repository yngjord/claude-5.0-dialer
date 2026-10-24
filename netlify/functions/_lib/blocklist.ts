import { CONNECTED_PICKUP_STATUS } from '../../../shared/constants';
import { BLOCKLIST_TABLE, buildBlocklistFields } from '../../../shared/blocklist';
import { createRecord } from './airtable';
import { db, must } from './db';

/**
 * Adds a wrapped-up human pickup to Airtable Blocklists 2.0, once per call (dialer_calls.blocklist_record_id).
 * Called in the background after a wrap-up is saved; the sweep retries any that failed.
 */
export async function addToBlocklist(callId: string): Promise<void> {
  const call = must(
    await db()
      .from('dialer_calls')
      .select('id, pickup_status, blocklist_record_id, full_name, email, phone_e164, website, linkedin, campaign_name, campaign:dialer_campaigns(airtable_client_id)')
      .eq('id', callId)
      .maybeSingle(),
  ) as {
    id: string;
    pickup_status: string | null;
    blocklist_record_id: string | null;
    full_name: string | null;
    email: string | null;
    phone_e164: string | null;
    website: string | null;
    linkedin: string | null;
    campaign_name: string | null;
    campaign: { airtable_client_id: string } | null;
  } | null;
  if (!call || call.pickup_status !== CONNECTED_PICKUP_STATUS || call.blocklist_record_id || !call.campaign?.airtable_client_id) return;

  const id = await createRecord(
    BLOCKLIST_TABLE,
    buildBlocklistFields({
      airtableClientId: call.campaign.airtable_client_id,
      fullName: call.full_name,
      email: call.email,
      phone: call.phone_e164,
      website: call.website,
      linkedin: call.linkedin,
      campaignName: call.campaign_name,
    }),
  );
  must(await db().from('dialer_calls').update({ blocklist_record_id: id }).eq('id', call.id));
}
