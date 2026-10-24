// Airtable "Blocklists 2.0": every human pickup is added, so the person isn't emailed or called again for that client
// (same fields the old JustCall automation filled). Written by field id, so renaming fields in Airtable is safe.

export const BLOCKLIST_TABLE = 'Blocklists 2.0';

const F = {
  client: 'fldITStrOdTH309Ue',
  blockLevel: 'fldrYy4qGvbCl05uS',
  origin: 'fldtVGwN5uYiDZGN2',
  name: 'fld2SoW3XttqFThAu',
  email: 'fldG5jPCHRqe5cc4O',
  phone: 'fldQSBSPNfZ34GqFO',
  domain: 'fldtWCAxtp7sD5crB',
  source: 'fldHRM9yswPCVPomf',
  linkedin: 'fldtvSxFUShLeSYUG',
} as const;

export interface BlocklistInput {
  airtableClientId: string;
  fullName: string | null;
  email: string | null;
  /** E.164, e.g. +61412345678 (the table's Normalised Phone Number strips it to digits). */
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  campaignName: string | null;
}

/** The Blocklists 2.0 record for a human pickup. Empty values are left out. */
export function buildBlocklistFields(input: BlocklistInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [F.client]: [input.airtableClientId],
    [F.blockLevel]: 'Person',
    [F.origin]: 'Cold Call pickup',
    [F.name]: input.fullName?.trim(),
    [F.email]: input.email?.trim(),
    [F.phone]: input.phone?.trim(),
    [F.domain]: input.website?.trim(),
    [F.source]: input.campaignName?.trim(),
    [F.linkedin]: input.linkedin?.trim(),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== ''));
}
