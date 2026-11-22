/**
 * Clay tables for campaign analysis (admin-only). A campaign links to the Clay table its leads came from; the analysis
 * reads that table through Clay's Public API instead of copying it into the dialer. Contacts are found in the table by
 * LinkedIn profile, else by first name + company domain.
 */

/** The table id from a Clay URL (…/tables/t_xxx/…) or a bare t_… id; null if there isn't one. */
export function clayTableId(input: string): string | null {
  const m = input.trim().match(/(?:^|\/tables\/)(t_[A-Za-z0-9]+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/** A LinkedIn profile's handle ("linkedin.com/in/jane-doe-123/" → "jane-doe-123"), lower-cased; null if not a profile. */
export function linkedinHandle(url: string | null | undefined): string | null {
  const m = (url ?? '').toLowerCase().match(/linkedin\.com\/in\/([^/?#\s]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim() || null;
  } catch {
    return m[1].trim() || null;
  }
}

/** "https://www.Acme.com.au/about" → "acme.com.au"; null if empty. */
export function websiteDomain(url: string | null | undefined): string | null {
  const d = (url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0];
  return d && d.includes('.') ? d : null;
}

/** The columns used to find contacts, picked by name (tables name them differently). */
export interface ClayKeyColumns {
  linkedin: string | null;
  firstName: string | null;
  domain: string | null;
}

export function keyColumns(names: string[]): ClayKeyColumns {
  const pick = (test: (n: string) => boolean) => names.find((n) => test(n.toLowerCase().trim())) ?? null;
  return {
    linkedin:
      pick((n) => /linkedin/.test(n) && /(profile|url|person)/.test(n) && !/company/.test(n)) ?? pick((n) => /linkedin/.test(n) && !/company/.test(n)),
    firstName: pick((n) => /^first[\s_-]?name$/.test(n)) ?? pick((n) => /first[\s_-]?name/.test(n)),
    domain: pick((n) => /^(domain|website|company domain|company website|domain\/website)$/.test(n)) ?? pick((n) => /(domain|website)/.test(n) && !/linkedin|email/.test(n)),
  };
}

export interface ClayKeyRow {
  linkedin: string | null;
  firstName: string | null;
  domain: string | null;
}

export interface MatchableContact {
  first_name: string | null;
  full_name: string | null;
  linkedin: string | null;
  website: string | null;
  email: string | null;
}

/** An index over a table's rows, for finding contacts in it. */
export function indexRows(rows: ClayKeyRow[]) {
  const byHandle = new Set<string>();
  const byNameDomain = new Set<string>();
  for (const r of rows) {
    const h = linkedinHandle(r.linkedin);
    if (h) byHandle.add(h);
    const fn = r.firstName?.trim().toLowerCase();
    const d = websiteDomain(r.domain);
    if (fn && d) byNameDomain.add(`${fn}|${d}`);
  }
  return { byHandle, byNameDomain };
}

/** Whether the table has this contact: same LinkedIn profile, else same first name at the same company domain. */
export function findsContact(index: ReturnType<typeof indexRows>, c: MatchableContact): boolean {
  const h = linkedinHandle(c.linkedin);
  if (h && index.byHandle.has(h)) return true;
  const fn = (c.first_name || c.full_name?.split(/\s+/)[0] || '').trim().toLowerCase();
  const d = websiteDomain(c.website) ?? websiteDomain(c.email?.split('@')[1]);
  return !!fn && !!d && index.byNameDomain.has(`${fn}|${d}`);
}

type Predicate = { field: string; op: string; value: string };
export type ClayFilter = Predicate | { or: ClayFilter[] } | { and: ClayFilter[] };

/** A LinkedIn handle as written in the contact's URL (original case), for a case-sensitive "contains" filter. */
function rawHandle(url: string | null | undefined): string | null {
  const m = (url ?? '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

/**
 * Clay filters that look these contacts up directly instead of reading the whole table: first by LinkedIn profile
 * (the handle as written and lower-cased, as Clay may compare case-sensitively), five people per request; then, for
 * contacts without a profile, first name + company domain, ten per request. Clay allows up to 10 conditions per "or".
 */
export function lookupFilters(contacts: MatchableContact[], cols: ClayKeyColumns): ClayFilter[] {
  const filters: ClayFilter[] = [];
  const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  if (cols.linkedin) {
    const handles = [...new Set(contacts.map((c) => rawHandle(c.linkedin)).filter((h): h is string => !!h))];
    for (const group of chunk(handles, 5)) {
      const preds = group.flatMap((h) => [...new Set([h, h.toLowerCase()])].map((v) => ({ field: cols.linkedin!, op: 'contains', value: `/in/${v}` })));
      filters.push(preds.length === 1 ? preds[0] : { or: preds });
    }
  }
  if (cols.firstName && cols.domain) {
    const pairs = contacts
      .filter((c) => !rawHandle(c.linkedin) || !cols.linkedin)
      .map((c) => ({ fn: (c.first_name || c.full_name?.split(/\s+/)[0] || '').trim(), d: websiteDomain(c.website) ?? websiteDomain(c.email?.split('@')[1]) }))
      .filter((x): x is { fn: string; d: string } => !!x.fn && !!x.d);
    for (const group of chunk(pairs, 10)) {
      const preds: ClayFilter[] = group.map((x) => ({ and: [{ field: cols.firstName!, op: '=', value: x.fn }, { field: cols.domain!, op: 'contains', value: x.d }] }));
      filters.push(preds.length === 1 ? preds[0] : { or: preds });
    }
  }
  return filters;
}

/** The analysis needs most of the campaign's contacts to be in the table. */
export const CLAY_MIN_MATCH = 0.5;

/** What the admin sees about a campaign's Clay table (from GET /api/admin/ai-insights). */
export interface ClayLinkStatus {
  tableId: string;
  tableUrl: string;
  checkedAt: string;
  rowsRead: number;
  tableComplete: boolean;
  contactsTotal: number;
  contactsMatched: number;
  columns: string[];
  /** Enough of the campaign's contacts were found for analysis. */
  valid: boolean;
}

export function clayLinkValid(matched: number, total: number): boolean {
  return total > 0 && matched / total >= CLAY_MIN_MATCH;
}

/** A dialer_campaign_clay row, as the admin sees it. */
export function clayStatus(r: {
  table_id: string;
  table_url: string;
  checked_at: string;
  rows_read: number;
  table_complete: boolean;
  contacts_total: number;
  contacts_matched: number;
  columns: string[];
}): ClayLinkStatus {
  return {
    tableId: r.table_id,
    tableUrl: r.table_url,
    checkedAt: r.checked_at,
    rowsRead: r.rows_read,
    tableComplete: r.table_complete,
    contactsTotal: r.contacts_total,
    contactsMatched: r.contacts_matched,
    columns: r.columns,
    valid: clayLinkValid(r.contacts_matched, r.contacts_total),
  };
}
