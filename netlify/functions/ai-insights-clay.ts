import type { Config } from '@netlify/functions';
import { clayStatus, clayTableId, findsContact, indexRows, keyColumns, type MatchableContact } from '../../shared/clay';
import { loadCampaign } from './_lib/aiInsights';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { clayColumns, clayConfigured, clayRows } from './_lib/clay';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/ai-insights/clay { campaignId, url }: admins only. Links a campaign to the Clay table its leads came
 * from, for analysis, after checking it: reads the table through Clay's Public API (only the columns used to find
 * people) and counts how many of the campaign's contacts it has, by LinkedIn profile, else first name + company domain.
 * Saved either way, so the admin sees the result; the analysis needs at least half the contacts found.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  requireAdmin(me);
  const body = await readJson<{ campaignId?: string; url?: string }>(req);
  if (!UUID.test(body.campaignId ?? '')) throw new HttpError(400, 'Choose a campaign.');
  const tableId = clayTableId(body.url ?? '');
  if (!tableId) throw new HttpError(400, 'That doesn’t look like a Clay table URL. Open the table in Clay and copy the address (it has /tables/t_… in it).');
  if (!clayConfigured()) throw new HttpError(409, 'The Clay API key isn’t set up on this site yet (CLAY_API_KEY in Netlify).');
  const campaign = await loadCampaign(body.campaignId!);
  if (!campaign) throw new HttpError(404, 'Campaign not found.');

  const columns = await clayColumns(tableId);
  const keys = keyColumns(columns);
  if (!keys.linkedin && !(keys.firstName && keys.domain)) {
    throw new HttpError(400, 'This table has no LinkedIn profile column (or first name and domain columns), so its people can’t be matched to contacts.');
  }
  const wanted = Object.fromEntries(Object.entries(keys).filter(([, v]) => v)) as Record<string, string>;
  const [{ rows, complete }, contacts] = await Promise.all([clayRows(tableId, wanted), campaignContacts(campaign.id)]);

  const index = indexRows(rows.map((r) => ({ linkedin: r.linkedin ?? null, firstName: r.firstName ?? null, domain: r.domain ?? null })));
  const matched = contacts.filter((c) => findsContact(index, c)).length;

  const saved = {
    campaign_id: campaign.id,
    table_id: tableId,
    table_url: body.url!.trim(),
    checked_at: new Date().toISOString(),
    checked_by: me.userId,
    rows_read: rows.length,
    table_complete: complete,
    contacts_total: contacts.length,
    contacts_matched: matched,
    columns,
  };
  must(await db().from('dialer_campaign_clay').upsert(saved, { onConflict: 'campaign_id' }));
  return json(clayStatus(saved));
});

/** Every contact in the campaign (in pages: campaigns can be large). */
async function campaignContacts(campaignId: string): Promise<MatchableContact[]> {
  const out: MatchableContact[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(
      await db().from('dialer_contacts').select('first_name, full_name, linkedin, website, email').eq('campaign_id', campaignId).order('id').range(from, from + 999),
    ) as MatchableContact[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export const config: Config = { path: '/api/admin/ai-insights/clay', method: 'POST' };
