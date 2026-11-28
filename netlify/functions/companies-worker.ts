import type { Config } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { labelCompany, type CompanyRow } from './_lib/companies';
import { db, must } from './_lib/db';

/** 12 minutes: the platform ends background jobs at 15; what's left is picked up by the next run. */
const DEADLINE_MS = 12 * 60_000;
const CONCURRENCY = 5;
const BATCH = 20;

/** The x-internal-key header against INTERNAL_JOB_KEY (constant time): only our own scheduled sweep starts this. */
function authorised(req: Request): boolean {
  const key = process.env.INTERNAL_JOB_KEY?.trim();
  const given = req.headers.get('x-internal-key') ?? '';
  if (!key || !given) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(key).digest());
}

/**
 * Background job, started by the companies sweep: labels companies (type, industry served, business model, summary)
 * from their website and LinkedIn page, five at a time, saving each as it finishes. Companies with nothing readable
 * are marked no_data; API errors are retried by later runs (up to 3 tries). Never throws: Netlify would rerun it.
 */
export default async (req: Request) => {
  if (!authorised(req)) return;
  // { max } labels at most that many (for a test run); otherwise it works through the queue until the deadline.
  const max = Number(((await req.json().catch(() => ({}))) as { max?: number }).max) || Infinity;
  const deadline = Date.now() + DEADLINE_MS;
  let done = 0;
  let empty = 0;
  let failed = 0;
  try {
    while (Date.now() < deadline && done + empty + failed < max) {
      const batch = must(await db().rpc('dialer_claim_companies', { p_limit: Math.min(BATCH, max - done - empty - failed) })) as (CompanyRow & { ai_attempts: number })[];
      if (!batch.length) break;
      let next = 0;
      const worker = async () => {
        while (next < batch.length) {
          const c = batch[next++];
          try {
            const r = await labelCompany(c);
            const fields =
              r.status === 'done'
                ? { ai_status: 'done', company_type: r.company_type, industry_served: r.industry_served, business_model: r.business_model, summary: r.summary, ai_model: r.model, ai_error: null }
                : { ai_status: 'no_data', ai_error: r.reason };
            must(await db().from('dialer_companies').update({ ...fields, ai_at: new Date().toISOString() }).eq('id', c.id));
            if (r.status === 'done') done++;
            else empty++;
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            await db().from('dialer_companies').update({ ai_status: 'error', ai_error: message.slice(0, 500), ai_attempts: c.ai_attempts + 1, ai_at: new Date().toISOString() }).eq('id', c.id);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      // Every company in the batch failing usually means the API itself is down or out of credit: stop for now.
      if (failed >= batch.length && done + empty === 0) break;
    }
  } catch (err) {
    console.error('Companies worker stopped', err);
  }
  console.log(`Companies worker: ${done} labelled, ${empty} with no data, ${failed} failed`);
};

export const config: Config = { path: '/api/internal/companies/label', method: 'POST', background: true };
