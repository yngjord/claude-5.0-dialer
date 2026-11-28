/**
 * Company labels, filled in on the backend from each company's website and LinkedIn page, for analysis (e.g. "which
 * type of company books most"). Fixed lists so counts are consistent across clients and campaigns.
 */

export const COMPANY_MODEL = 'claude-haiku-5-5';

export const COMPANY_TYPES = [
  'B2B SaaS / software',
  'Fintech',
  'Consumer tech / marketplace',
  'IT services / MSP / consultancy',
  'Marketing / creative agency',
  'Recruitment / staffing',
  'Education provider',
  'Healthcare provider',
  'Financial services',
  'Retail / e-commerce',
  'Manufacturing / industrial',
  'Construction / property',
  'Telco / infrastructure',
  'Professional services',
  'Government / public sector',
  'Non-profit',
  'Other',
] as const;

export const INDUSTRIES_SERVED = [
  'Cross-industry',
  'Technology',
  'Financial services',
  'Healthcare',
  'Education',
  'Government',
  'Retail / e-commerce',
  'Construction / property',
  'Manufacturing / industrial',
  'Mining / resources / energy',
  'Hospitality / travel',
  'Professional services',
  'Media / entertainment',
  'Transport / logistics',
  'Agriculture',
  'Not-for-profit',
  'Consumers',
  'Other',
] as const;

export const BUSINESS_MODELS = ['B2B', 'B2C', 'B2G', 'Mixed'] as const;

/** LinkedIn's size brackets (the database works them out from the headcount: dialer_size_bracket). */
export const SIZE_BRACKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'] as const;

/** Too little readable text to judge a company: it's marked "no data" instead of guessed. */
export const MIN_COMPANY_TEXT = 200;
/** Per page, after the markup is stripped. */
export const MAX_PAGE_TEXT = 6000;

export const COMPANY_INSTRUCTIONS = `You label companies for a B2B sales team's analysis, so labels must be consistent from one company to the next.

You get text taken from a company's website (home page and, when found, an About page) and sometimes its LinkedIn page. Use only that text: don't rely on what you might know about a company by name, and don't guess.

Return:
- enough_information: false when the text doesn't make clear what the company does (a parked or broken site, a login page, a holding page, cookie banners only). Then leave every other field null.
- company_type: what the company is, from the list. Classify by its main business:
  - "B2B SaaS / software": sells its own software or platform to businesses.
  - "Fintech": its own technology product for payments, lending, banking, insurance or investing.
  - "Consumer tech / marketplace": apps, platforms or marketplaces for consumers or matching two sides.
  - "IT services / MSP / consultancy": IT support, managed services, cloud partners, systems integrators, software development for clients, tech consulting.
  - "Marketing / creative agency": marketing, advertising, design, PR, web or content agencies.
  - "Recruitment / staffing": recruiters, staffing and labour hire.
  - "Education provider": schools, universities, colleges, RTOs, training and course providers.
  - "Healthcare provider": clinics, hospitals, care and allied health services (not health software).
  - "Financial services": banks, insurers, super funds, accountants, brokers, advisers, investment firms (not their own tech product).
  - "Professional services": law, engineering, management consulting and other advisory firms.
  - Otherwise the closest of the rest, or "Other".
- industry_served: who the company's customers mainly are, from the list. "Cross-industry" when they sell to businesses of many kinds; "Consumers" when they mainly sell to the public.
- business_model: who pays them: "B2B" (businesses), "B2C" (the public), "B2G" (government), "Mixed" when no single one dominates.
- summary: at most 50 words, plain and factual: what they do, who for, and their main product or service. No marketing language, no superlatives, no "leading".`;

/** One company's pages, shaped for the labelling request. */
export function companyPrompt(c: { name: string | null; domain: string | null; linkedinUrl: string | null }, pages: { source: string; text: string }[]): string {
  return [
    `Company: ${c.name ?? 'unknown name'}`,
    c.domain ? `Website: ${c.domain}` : null,
    c.linkedinUrl ? `LinkedIn: ${c.linkedinUrl}` : null,
    ...pages.map((p) => `\n<page source="${p.source}">\n${p.text}\n</page>`),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The readable text of an HTML page: its title and description, then the body without scripts, styles and markup,
 * capped at `max` characters.
 */
export function pageText(html: string, max = MAX_PAGE_TEXT): string {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1] ??
    '';
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const description = meta('description') || meta('og:description');
  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = [title, description, body]
    .map((s) => decodeEntities(s))
    .join('\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.slice(0, max);
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** The site's About page, if the home page links to one on the same site. */
export function aboutLink(html: string, base: string): string | null {
  const hrefs = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const pick = hrefs.find((h) => /\/(about|about-us|company|who-we-are|our-story)(\/|$|\?)/i.test(h));
  if (!pick) return null;
  try {
    const url = new URL(pick, base);
    return url.hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, '') ? url.toString() : null;
  } catch {
    return null;
  }
}
