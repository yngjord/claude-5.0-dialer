import { createClient } from '@supabase/supabase-js';
import type { Me, Role } from '../../../shared/types';
import { db, must } from './db';
import { env, HttpError } from './http';

/**
 * Resolves the logged-in user from the Supabase access token (same login as the portal) and checks their role.
 * Only Maronly staff (profiles.role = team or admin) can use the dialer; portal clients are refused.
 */
export async function requireDialerUser(req: Request): Promise<Me> {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Not signed in');

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Session expired. Please sign in again.');

  return loadDialerUser(data.user.id, data.user.email ?? '');
}

export async function loadDialerUser(userId: string, email?: string): Promise<Me> {
  const profile = must(await db().from('profiles').select('role, email, display_name').eq('id', userId).maybeSingle()) as {
    role: string;
    email: string | null;
    display_name: string | null;
  } | null;
  const role = profile?.role;
  if (role !== 'team' && role !== 'admin') throw new HttpError(403, 'The dialer is only available to the Maronly team.');
  const mail = email || profile?.email || '';
  return { userId, email: mail, role: role as Role, displayName: profile?.display_name?.trim() || mail };
}

export function requireAdmin(me: Me): void {
  if (me.role !== 'admin') throw new HttpError(403, 'Only admins can do this.');
}

/** Admins can use every campaign; team members only the ones they're assigned to. */
export async function requireCampaignAccess(me: Me, campaignId: string): Promise<void> {
  if (me.role === 'admin') return;
  const row = must(await db().from('dialer_campaign_members').select('user_id').eq('campaign_id', campaignId).eq('user_id', me.userId).maybeSingle());
  if (!row) throw new HttpError(403, "You're not assigned to this campaign.");
}
