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
