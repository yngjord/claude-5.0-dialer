import { env } from './http';

const SCRAPE_URL = 'https://app.icypeas.com/api/scrape';

/** The parts of an Icypeas company result we use. */
export interface IcypeasCompany {
  url?: string;
  name?: string;
  numberOfEmployees?: number;
  headcountRange?: string;
  description?: string;
  industry?: string;
}

export const icypeasConfigured = () => !!process.env.ICYPEAS_API_KEY?.trim();

/** "https://www.linkedin.com/company/Acme/" → "acme". */
export function slugOf(url: string | null | undefined): string | null {
  const m = (url ?? '').match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** The headcount to store: the count when Icypeas knows it (-1 means unknown), else its range. */
export function headcountOf(c: IcypeasCompany): string | null {
  if (typeof c.numberOfEmployees === 'number' && c.numberOfEmployees > 0) return String(c.numberOfEmployees);
  return c.headcountRange?.trim() || null;
}

/**
 * Up to 50 LinkedIn company pages in one call (Icypeas answers straight away). Returns each found company by its slug.
 * Throws on auth, rate-limit and server errors so the job can stop and retry later.
 */
export async function scrapeCompanies(urls: string[]): Promise<Map<string, IcypeasCompany>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(SCRAPE_URL, {
      method: 'POST',
      headers: { Authorization: env('ICYPEAS_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'company', data: urls }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status === 401) throw new Error('Icypeas refused the API key (ICYPEAS_API_KEY in Netlify).');
    if (!res.ok) throw new Error(`Icypeas answered ${res.status}.`);
    const body = (await res.json()) as {
      success?: boolean;
      validationErrors?: unknown;
      data?: { searchId?: string; status?: string; result?: IcypeasCompany }[];
    };
    if (body.success === false) throw new Error(`Icypeas refused the request: ${JSON.stringify(body.validationErrors ?? '').slice(0, 200)}`);
    const out = new Map<string, IcypeasCompany>();
    (body.data ?? []).forEach((item, i) => {
      if (item.status !== 'FOUND' || !item.result) return;
      // Matched by the URL Icypeas returns; by position if it didn't return one.
      const slug = slugOf(item.result.url) ?? slugOf(urls[i]);
      if (slug) out.set(slug, item.result);
    });
    return out;
  }
}
