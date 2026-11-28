import type { Config } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db, must } from './_lib/db';
import { headcountOf, icypeasConfigured, scrapeCompanies } from './_lib/icypeas';

const DEADLINE_MS = 12 * 60_000;
const BATCH = 50;

function authorised(req: Request): boolean {
  const key = process.env.INTERNAL_JOB_KEY?.trim();
  const given = req.headers.get('x-internal-key') ?? '';
  if (!key || !given) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(key).digest());
}

type Claimed = { id: string; linkedin_slug: string; ai_status: string };

/**
 * Background job (our key only), started by the companies sweep: looks up companies that have a LinkedIn page and no
 * headcount on Icypeas, 50 per call, and saves the headcount (count, or range when the count is unknown) plus the
 * page's description and industry. Companies Icypeas can't find are marked so they aren't paid for again. A company
 * whose website couldn't be read is queued to be labelled again from its LinkedIn description. { max } caps a run.
 */
export default async (req: Request) => {
  if (!authorised(req) || !icypeasConfigured()) return;
  const max = Number(((await req.json().catch(() => ({}))) as { max?: number }).max) || Infinity;
  const deadline = Date.now() + DEADLINE_MS;
  let found = 0;
  let missing = 0;
  try {
    while (Date.now() < deadline && found + missing < max) {
      const batch = must(await db().rpc('dialer_claim_headcount', { p_limit: Math.min(BATCH, max - found - missing) })) as Claimed[];
      if (!batch.length) break;
      let results: Awaited<ReturnType<typeof scrapeCompanies>>;
      try {
        results = await scrapeCompanies(batch.map((c) => `https://www.linkedin.com/company/${c.linkedin_slug}`));
      } catch (err) {
        console.error('Companies headcount: Icypeas failed', err);
        await db().from('dialer_companies').update({ icypeas_status: 'error', icypeas_at: new Date().toISOString() }).in('id', batch.map((c) => c.id));
        break; // Auth, rate limit or outage: the next sweep tries again.
      }
      for (const c of batch) {
        const r = results.get(c.linkedin_slug);
        const now = new Date().toISOString();
        if (!r) {
          missing++;
          must(await db().from('dialer_companies').update({ icypeas_status: 'not_found', icypeas_at: now }).eq('id', c.id));
          continue;
        }
        found++;
        const headcount = headcountOf(r);
        must(
          await db()
            .from('dialer_companies')
            .update({
              icypeas_status: 'found',
              icypeas_at: now,
              linkedin_description: r.description?.trim().slice(0, 4000) || null,
              linkedin_industry: r.industry?.trim() || null,
              ...(headcount ? { headcount_raw: headcount, headcount_source: 'icypeas' } : {}),
              // Couldn't read the website before: label it again, now from the LinkedIn description.
              ...(c.ai_status === 'no_data' && r.description?.trim() ? { ai_status: 'pending', ai_attempts: 0 } : {}),
            })
            .eq('id', c.id)
            .is('headcount_raw', null),
        );
      }
    }
  } catch (err) {
    console.error('Companies headcount job stopped', err);
  }
  console.log(`Companies headcount: ${found} found, ${missing} not found`);
};

export const config: Config = { path: '/api/internal/companies/headcount', method: 'POST', background: true };
