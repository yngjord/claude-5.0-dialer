import { companyColumns, keyColumns, lookupFilters, rowIndex, type MatchableContact } from '../../../shared/clay';
import { clayColumns, clayConfigured, clayFind } from './clay';
import { db, must } from './db';

type ContactRow = MatchableContact & { id: string; company_linkedin: string | null; employee_count: string | null };

const COMPANY_PAGE = /linkedin\.com\/(company|school|showcase)\//i;

/**
 * Fills in what the campaign's Clay table knows about each contact's company and the contact itself doesn't have yet:
 * the company LinkedIn page, the headcount, and the website. Saving them on the contact links (or completes) its
 * company, which the companies jobs then label and enrich. Only reads the table: no Clay credits.
 */
export async function backfillFromClay(campaignId: string): Promise<{ contacts: number; updated: number; skipped?: string }> {
  if (!clayConfigured()) return { contacts: 0, updated: 0, skipped: 'CLAY_API_KEY is not set' };
  const link = must(await db().from('dialer_campaign_clay').select('table_id, columns').eq('campaign_id', campaignId).maybeSingle()) as { table_id: string; columns: string[] } | null;
  if (!link) return { contacts: 0, updated: 0, skipped: 'no Clay table' };

  // The table's columns as they are now (they may have been added or fixed since the table was last checked).
  const columns = await clayColumns(link.table_id).catch(() => link.columns);
  if (columns.join('|') !== link.columns.join('|')) await db().from('dialer_campaign_clay').update({ columns }).eq('campaign_id', campaignId);
  const keys = keyColumns(columns);
  const company = companyColumns(columns);
  if (!keys.linkedin && !(keys.firstName && keys.domain)) return { contacts: 0, updated: 0, skipped: 'no columns to match contacts by' };
  if (!company.companyLinkedin && !company.headcount && !keys.domain) return { contacts: 0, updated: 0, skipped: 'no company columns' };

  const contacts: ContactRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(
      await db().from('dialer_contacts').select('id, first_name, full_name, linkedin, website, email, company_linkedin, employee_count').eq('campaign_id', campaignId).order('id').range(from, from + 999),
    ) as ContactRow[];
    contacts.push(...page);
    if (page.length < 1000) break;
  }
  // Only contacts missing something the table could add. A "company LinkedIn" that isn't a company page (e.g. a
  // person's profile mapped into that column) counts as missing, so the table's value replaces it.
  const hasCompanyPage = (c: ContactRow) => COMPANY_PAGE.test(c.company_linkedin ?? '');
  const wanting = contacts.filter(
    (c) => (company.companyLinkedin && !hasCompanyPage(c)) || (company.headcount && !c.employee_count?.trim()) || (keys.domain && !c.website?.trim()),
  );
  if (!wanting.length) return { contacts: contacts.length, updated: 0 };

  const wanted = Object.fromEntries(
    Object.entries({ ...keys, companyLinkedin: company.companyLinkedin, headcount: company.headcount }).filter(([, v]) => v),
  ) as Record<string, string>;
  const rows = await clayFind(link.table_id, wanted, lookupFilters(wanting, keys));
  const index = rowIndex(rows.map((r) => ({ linkedin: r.linkedin ?? null, firstName: r.firstName ?? null, domain: r.domain ?? null, companyLinkedin: r.companyLinkedin ?? null, headcount: r.headcount ?? null })));

  let updated = 0;
  for (const c of wanting) {
    const row = index.find(c);
    if (!row) continue;
    const patch: { company_linkedin?: string; employee_count?: string; website?: string } = {};
    if (row.companyLinkedin?.trim() && COMPANY_PAGE.test(row.companyLinkedin) && !hasCompanyPage(c)) patch.company_linkedin = row.companyLinkedin.trim();
    if (row.headcount?.trim() && !c.employee_count?.trim()) patch.employee_count = row.headcount.trim();
    if (row.domain?.trim() && !c.website?.trim()) patch.website = row.domain.trim();
    if (!Object.keys(patch).length) continue;
    must(await db().from('dialer_contacts').update(patch).eq('id', c.id));
    updated++;
  }
  return { contacts: contacts.length, updated };
}
