import type { Config } from '@netlify/functions';
import { backfillFromClay } from './_lib/companyClay';
import { internalAuthorised, startLabelling } from './_lib/companyJobs';
import { db, must } from './_lib/db';

/**
 * Background job (our key only): for every campaign with a Clay table connected, copies the company LinkedIn page,
 * headcount and website from the table onto contacts that don't have them, so their companies can be labelled and
 * enriched. Safe to run again: it only fills gaps. Never throws: Netlify would rerun it.
 */
export default async (req: Request) => {
  if (!internalAuthorised(req)) return;
  const links = must(await db().from('dialer_campaign_clay').select('campaign_id')) as { campaign_id: string }[];
  for (const { campaign_id } of links) {
    try {
      const r = await backfillFromClay(campaign_id);
      console.log('Clay company backfill', campaign_id, r);
    } catch (err) {
      console.error('Clay company backfill failed', campaign_id, err);
    }
  }
  await startLabelling();
};

export const config: Config = { path: '/api/internal/companies/clay-backfill', method: 'POST', background: true };
