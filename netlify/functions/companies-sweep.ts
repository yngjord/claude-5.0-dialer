import type { Config } from '@netlify/functions';
import { db } from './_lib/db';

/**
 * Every 15 minutes (production only: Netlify runs scheduled functions on the live site): if any company is waiting for
 * its labels (new, left over by a stopped run, or failed and due another try), starts the companies worker, which runs
 * in the background for up to 15 minutes. The worker's claim decides exactly which companies it takes.
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
  if (!count) return;
  await fetch(`${site}/api/internal/companies/label`, { method: 'POST', headers: { 'x-internal-key': key } });
};

export const config: Config = { schedule: '*/15 * * * *' };
