import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  aboutLink,
  BUSINESS_MODELS,
  COMPANY_INSTRUCTIONS,
  COMPANY_MODEL,
  COMPANY_TYPES,
  companyPrompt,
  INDUSTRIES_SERVED,
  MIN_COMPANY_TEXT,
  pageText,
} from '../../../shared/companies';
import { env } from './http';

let client: Anthropic | null = null;
const claude = () => (client ??= new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 4 }));

const Labels = z.object({
  enough_information: z.boolean(),
  company_type: z.enum(COMPANY_TYPES).nullable(),
  industry_served: z.enum(INDUSTRIES_SERVED).nullable(),
  business_model: z.enum(BUSINESS_MODELS).nullable(),
  summary: z.string().nullable(),
});

export interface CompanyRow {
  id: string;
  domain: string | null;
  linkedin_url: string | null;
  linkedin_slug: string | null;
  name: string | null;
  /** From the headcount job (Icypeas): the LinkedIn page's own description and industry. */
  linkedin_description?: string | null;
  linkedin_industry?: string | null;
}

export type CompanyResult =
  | { status: 'done'; company_type: string | null; industry_served: string | null; business_model: string | null; summary: string; model: string }
  | { status: 'no_data'; reason: string };

/** A page's HTML, or null if it can't be fetched (8 seconds, at most ~1.5 MB, HTML only). */
async function fetchHtml(url: string): Promise<{ html: string; url: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    const html = (await res.text()).slice(0, 1_500_000);
    return { html, url: res.url || url };
  } catch {
    return null;
  }
}

/** The text we can read about a company: home page, About page, and its LinkedIn page when LinkedIn allows it. */
export async function companyPages(c: CompanyRow): Promise<{ source: string; text: string }[]> {
  const pages: { source: string; text: string }[] = [];
  if (c.domain) {
    const home = (await fetchHtml(`https://${c.domain}/`)) ?? (await fetchHtml(`http://${c.domain}/`));
    if (home) {
      pages.push({ source: 'website home page', text: pageText(home.html) });
      const about = aboutLink(home.html, home.url);
      const page = about ? await fetchHtml(about) : null;
      if (page) pages.push({ source: 'website About page', text: pageText(page.html, 4000) });
    }
  }
  if (c.linkedin_description?.trim()) {
    // Already fetched by the headcount job: better than LinkedIn's public page, which usually needs a sign-in.
    pages.push({ source: 'LinkedIn description', text: [c.linkedin_industry && `Industry: ${c.linkedin_industry}`, c.linkedin_description.trim()].filter(Boolean).join('\n') });
  } else if (c.linkedin_slug) {
    const li = await fetchHtml(`https://www.linkedin.com/company/${c.linkedin_slug}/`);
    // Usually a sign-in wall; its text is only useful when it carries the company's own description.
    const text = li ? pageText(li.html, 3000) : '';
    if (text && !/sign in|join now|authwall/i.test(text.slice(0, 300))) pages.push({ source: 'LinkedIn page', text });
  }
  return pages.filter((p) => p.text.length > 40);
}

/** Labels one company from its pages, or says why it couldn't. Throws on API errors (the worker retries those later). */
export async function labelCompany(c: CompanyRow): Promise<CompanyResult> {
  const pages = await companyPages(c);
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  if (total < MIN_COMPANY_TEXT) return { status: 'no_data', reason: c.domain ? 'The website couldn’t be read.' : 'No website, and LinkedIn wouldn’t show the page.' };

  const res = await claude().beta.messages.parse({
    model: COMPANY_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: betaZodOutputFormat(Labels) },
    system: [{ type: 'text', text: COMPANY_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: companyPrompt({ name: c.name, domain: c.domain, linkedinUrl: c.linkedin_url }, pages) }],
  });
  if (res.stop_reason === 'refusal') return { status: 'no_data', reason: 'Claude declined to label this company.' };
  const out = res.parsed_output;
  if (res.stop_reason === 'max_tokens' || !out) throw new Error('The labels came back incomplete.');
  if (!out.enough_information || !out.summary?.trim()) return { status: 'no_data', reason: 'The website doesn’t say clearly what the company does.' };
  const words = out.summary.trim().split(/\s+/);
  return {
    status: 'done',
    company_type: out.company_type,
    industry_served: out.industry_served,
    business_model: out.business_model,
    summary: words.length > 60 ? `${words.slice(0, 60).join(' ')}…` : words.join(' '),
    model: res.model,
  };
}
