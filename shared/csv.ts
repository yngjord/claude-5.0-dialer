import { normalizePhone } from './phone';

/** Parses CSV text (RFC 4180: quoted fields, "" escapes, newlines inside quotes, CRLF/LF). Skips fully empty rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export const CONTACT_FIELDS = ['full_name', 'first_name', 'last_name', 'phone', 'email', 'company', 'title', 'linkedin', 'website'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  phone: 'Phone',
  email: 'Email',
  company: 'Company',
  title: 'Job title',
  linkedin: 'LinkedIn URL',
  website: 'Website',
};

/** Column index → contact field, or 'custom' (kept under its header name) or 'skip'. */
export type ColumnMapping = (ContactField | 'custom' | 'skip')[];

const GUESSES: [RegExp, ContactField][] = [
  [/^(full)?name$|^(contact|prospect|person)(full)?name$/, 'full_name'],
  [/^first(name)?$|^given(name)?$/, 'first_name'],
  [/^last(name)?$|^surname$|^family(name)?$/, 'last_name'],
  [/phone|mobile|^cell|number$/, 'phone'],
  [/e?mail/, 'email'],
  // LinkedIn before website ("LinkedIn URL"), website before company ("Company Website").
  [/linkedin/, 'linkedin'],
  [/website|domain|url|site/, 'website'],
  [/company|organi[sz]ation|account|business/, 'company'],
  [/title|role|position/, 'title'],
];

export function guessMapping(headers: string[]): ColumnMapping {
  const used = new Set<ContactField>();
  return headers.map((h) => {
    const key = h.toLowerCase().replace(/[^a-z]/g, '');
    const hit = GUESSES.find(([re, field]) => !used.has(field) && re.test(key));
    if (!hit) return 'custom';
    used.add(hit[1]);
    return hit[1];
  });
}

export interface ImportContact {
  full_name: string | null;
  first_name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  phone_e164: string;
  phone_raw: string;
  linkedin: string | null;
  website: string | null;
  custom: Record<string, string>;
}

export interface ImportPreview {
  valid: ImportContact[];
  invalid: { row: number; phone: string; name: string; reason: string }[];
  /** Rows whose number already appears earlier in the file, or in `existingPhones`. */
  duplicates: number;
}

/** Turns parsed rows (header row first) into contacts, using the column mapping. */
export function buildImport(rows: string[][], mapping: ColumnMapping, existingPhones: Set<string> = new Set()): ImportPreview {
  const [headers, ...body] = rows;
  const seen = new Set(existingPhones);
  const preview: ImportPreview = { valid: [], invalid: [], duplicates: 0 };
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

  body.forEach((cells, i) => {
    const get = (field: ContactField) => clean(cells[mapping.indexOf(field)]);
    const custom: Record<string, string> = {};
    mapping.forEach((m, col) => {
      const v = clean(cells[col]);
      if (m === 'custom' && v && headers[col]?.trim()) custom[headers[col].trim()] = v;
    });

    const first = get('first_name');
    const last = get('last_name');
    const fullName = get('full_name') ?? ([first, last].filter(Boolean).join(' ') || null);
    const rawPhone = get('phone') ?? '';
    const phone = normalizePhone(rawPhone);

    if (!phone.ok) {
      preview.invalid.push({ row: i + 2, phone: rawPhone, name: fullName ?? '', reason: phone.reason });
      return;
    }
    if (seen.has(phone.e164)) {
      preview.duplicates++;
      return;
    }
    seen.add(phone.e164);

    preview.valid.push({
      full_name: fullName,
      first_name: first ?? fullName?.split(/\s+/)[0] ?? null,
      company: get('company'),
      title: get('title'),
      email: get('email'),
      phone_e164: phone.e164,
      phone_raw: rawPhone,
      linkedin: get('linkedin'),
      website: get('website'),
      custom,
    });
  });

  return preview;
}
