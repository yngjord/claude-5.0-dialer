import type { Config } from '@netlify/functions';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { startHeadcount, startLabelling } from './_lib/companyJobs';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';
import { icypeasConfigured } from './_lib/icypeas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/companies { action, campaignId? }
 * - "label" (anyone signed in to the dialer, after an upload): starts labelling any new companies. Free to call: it
 *   does nothing when no company is waiting, and the job keeps to its daily cap.
 * - "headcount" (admins): looks up headcounts on LinkedIn (Icypeas, paid) for the campaign's companies without one.
 */
export default handler(async (req, context) => {
  const me = await requireDialerUser(req);
  const body = await readJson<{ action?: string; campaignId?: string }>(req);
  if (body.action === 'label') {
    context.waitUntil(startLabelling());
    return json({ ok: true });
  }
  if (body.action !== 'headcount') throw new HttpError(400, 'Unknown action.');
  requireAdmin(me);
  if (!UUID.test(body.campaignId ?? '')) throw new HttpError(400, 'Choose a campaign.');
  if (!icypeasConfigured()) throw new HttpError(409, 'The Icypeas API key isn’t set up on this site (ICYPEAS_API_KEY in Netlify).');
  const exists = must(await db().from('dialer_campaigns').select('id').eq('id', body.campaignId!).maybeSingle());
  if (!exists) throw new HttpError(404, 'Campaign not found.');
  if (!(await startHeadcount(body.campaignId!))) throw new HttpError(502, 'Couldn’t start the headcount lookup. Try again in a minute.');
  return json({ ok: true });
});

export const config: Config = { path: '/api/companies', method: 'POST' };
