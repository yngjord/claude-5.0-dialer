import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

/**
 * POST /api/admin/view-as { userId }: lets an admin sign in as a team member to see the dialer exactly as they do
 * (their campaigns, calls, leads). Returns a one-time sign-in token for that member, which the browser swaps its
 * session for; the admin's own session is kept in the browser to switch back. Team members only (never another
 * admin or a client), and only admins can ask.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  requireAdmin(me);
  const { userId } = await readJson<{ userId: string }>(req);

  const target = must(await db().from('profiles').select('id, role, email, display_name').eq('id', userId ?? '').maybeSingle()) as {
    id: string;
    role: string;
    email: string | null;
    display_name: string | null;
  } | null;
  if (!target || target.role !== 'team' || !target.email) throw new HttpError(400, 'You can only view as a team member.');

  const { data, error } = await db().auth.admin.generateLink({ type: 'magiclink', email: target.email });
  if (error || !data.properties?.hashed_token) throw new Error(`Supabase: ${error?.message ?? 'no token'}`);
  console.log(`View as: ${me.email} is viewing as ${target.email}`);
  return json({ tokenHash: data.properties.hashed_token, name: target.display_name?.trim() || target.email });
});

export const config: Config = { path: '/api/admin/view-as', method: 'POST' };
