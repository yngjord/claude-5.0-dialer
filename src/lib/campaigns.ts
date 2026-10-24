import type { Campaign } from '../../shared/types';
import { must } from './api';
import { supabase } from './supabase';

export type CampaignRow = Campaign & { campaign_members: { user_id: string }[] };

/**
 * Makes `userId` the campaign's one team member (null: nobody), replacing `current`. Removes before adding, since the
 * database allows only one team member per campaign.
 */
export async function setTeamMember(campaignId: string, userId: string | null, current: string[]): Promise<void> {
  const remove = current.filter((id) => id !== userId);
  if (remove.length) must(await supabase.from('dialer_campaign_members').delete().eq('campaign_id', campaignId).in('user_id', remove));
  if (userId && !current.includes(userId)) must(await supabase.from('dialer_campaign_members').insert({ campaign_id: campaignId, user_id: userId }));
}
