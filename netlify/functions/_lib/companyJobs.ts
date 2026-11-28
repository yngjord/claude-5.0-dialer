import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from './db';

/** The x-internal-key header against INTERNAL_JOB_KEY (constant time): only our own functions start the companies jobs. */
export function internalAuthorised(req: Request): boolean {
  const key = process.env.INTERNAL_JOB_KEY?.trim();
  const given = req.headers.get('x-internal-key') ?? '';
  if (!key || !given) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(key).digest());
}

/** This deploy's own address (a preview's functions start the preview's jobs; production's start production's). */
function siteUrl(): string | undefined {
  return process.env.CONTEXT === 'production' ? process.env.URL : (process.env.DEPLOY_PRIME_URL ?? process.env.URL);
}

async function startJob(path: string, body: Record<string, unknown> = {}): Promise<boolean> {
  const key = process.env.INTERNAL_JOB_KEY?.trim();
  const site = siteUrl();
  if (!key || !site) {
    console.error('Companies job: INTERNAL_JOB_KEY or the site URL is missing.');
    return false;
  }
  const res = await fetch(`${site}${path}`, { method: 'POST', headers: { 'x-internal-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) console.error('Companies job: could not start', path, res.status);
  return res.ok;
}

/**
 * Starts the labelling job if any company is waiting (new, left by a stopped run, or failed and due another try).
 * Called whenever companies are added: an upload, a Clay check, an inbound lead, a headcount run. Nothing runs on a
 * timer. The job itself enforces the daily cap.
 */
export async function startLabelling(): Promise<void> {
  try {
    const { count, error } = await db()
      .from('dialer_companies')
      .select('id', { count: 'exact', head: true })
      .or('ai_status.eq.pending,and(ai_status.eq.working,ai_at.lt.' + new Date(Date.now() - 20 * 60_000).toISOString() + '),and(ai_status.eq.error,ai_attempts.lt.3)');
    if (error) throw error;
    if (count) await startJob('/api/internal/companies/label');
  } catch (err) {
    console.error('Companies: could not start labelling', err);
  }
}

/** Starts the (paid) headcount lookup for one campaign's companies. Only an admin's click calls this. */
export const startHeadcount = (campaignId: string) => startJob('/api/internal/companies/headcount', { campaignId });
