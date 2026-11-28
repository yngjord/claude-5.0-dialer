import type { Config } from '@netlify/functions';
import { db } from './_lib/db';

/**
 * Every 15 minutes (production only: Netlify runs scheduled functions on the live site): if any company is waiting for
 * its labels (new, left over by a stopped run, or failed and due another try), starts the companies worker; if any
 * needs a headcount from LinkedIn, starts the headcount job. Both run in the background for up to 15 minutes, and
 * their claims decide exactly which companies they take.
 */
export default async () => {
  const key = process.env.INTERNAL_JOB_KEY?.trim();
  const site = process.env.URL;
  if (!key || !site) return console.error('Companies sweep: INTERNAL_JOB_KEY or URL is missing.');
  const { count, error } = await db()
    .from('dialer_companies')
    .select('id', { count: 'exact', head: true })
    .or('ai_status.eq.pending,ai_status.eq.working,and(ai_status.eq.error,ai_attempts.lt.3)');
  if (error) return console.error('Companies sweep: could not count waiting companies', error);
  if (count) await fetch(`${site}/api/internal/companies/label`, { method: 'POST', headers: { 'x-internal-key': key }, body: '{}' });

  // Headcount from LinkedIn (Icypeas) for companies with a LinkedIn page and none uploaded.
  if (!process.env.ICYPEAS_API_KEY?.trim()) return;
  const { count: needHeadcount } = await db()
    .from('dialer_companies')
    .select('id', { count: 'exact', head: true })
    .not('linkedin_slug', 'is', null)
    .is('headcount_raw', null)
    .or('icypeas_status.is.null,icypeas_status.eq.working,icypeas_status.eq.error');
  if (needHeadcount) await fetch(`${site}/api/internal/companies/headcount`, { method: 'POST', headers: { 'x-internal-key': key }, body: '{}' });
};

export const config: Config = { schedule: '*/15 * * * *' };
