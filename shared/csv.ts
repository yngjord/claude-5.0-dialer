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

/** A saved custom field (dialer_custom_fields). Contacts store custom values under `key`. */
export interface CustomField {
  key: string;
  label: string;
  /** Normalised CSV headers that were mapped to this field before, so the next import maps them again. */
  aliases: string[];
}

/** Where one CSV column goes. */
export type ColumnTarget =
  | { kind: 'field'; field: ContactField }
  | { kind: 'custom'; key: string }
  | { kind: 'new'; label: string }
  | { kind: 'skip' };
export type ColumnMapping = ColumnTarget[];

/** "Employee Count" / "employee_count" / "EMPLOYEE-COUNT" → "employeecount", for matching headers. */
export const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Employee Count" → "employee_count": the key a new custom field is saved under. */
export const customFieldKey = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'field';

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

/**
 * First guess at where each column goes: a standard contact field, else a saved custom field whose name or a
 * previously mapped header matches, else a new custom field named after the header. Blank headers are skipped.
 */
export function guessMapping(headers: string[], customFields: CustomField[] = []): ColumnMapping {
  const used = new Set<ContactField>();
  const usedCustom = new Set<string>();
  return headers.map((h): ColumnTarget => {
    const hk = headerKey(h);
    if (!hk) return { kind: 'skip' };
    const hit = GUESSES.find(([re, field]) => !used.has(field) && re.test(h.toLowerCase().replace(/[^a-z]/g, '')));
    if (hit) {
      used.add(hit[1]);
      return { kind: 'field', field: hit[1] };
    }
    const saved = customFields.find(
      (f) => !usedCustom.has(f.key) && (headerKey(f.label) === hk || f.key === customFieldKey(h) || f.aliases.includes(hk)),
    );
    if (saved) {
      usedCustom.add(saved.key);
      return { kind: 'custom', key: saved.key };
    }
    return { kind: 'new', label: h.trim() };
  });
}

/** Custom field key a column's values are stored under, or null if the column isn't a custom field. */
export function columnCustomKey(t: ColumnTarget): string | null {
  return t.kind === 'custom' ? t.key : t.kind === 'new' ? customFieldKey(t.label) : null;
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

export interface ImportRowIssue {
  row: number;
  phone: string;
  name: string;
  reason: string;
}

export interface ImportPreview {
  /** Every row with a valid number, duplicates included. */
  valid: ImportContact[];
  /** `valid` without the duplicates: what's imported when de-duplicating. */
  unique: ImportContact[];
  invalid: ImportRowIssue[];
  /** Rows whose number already appears earlier in the file, or in `existingPhones` (the client's contacts). */
  duplicates: ImportRowIssue[];
}

/** Turns parsed rows (header row first) into contacts, using the column mapping. */
export function buildImport(rows: string[][], mapping: ColumnMapping, existingPhones: Set<string> = new Set()): ImportPreview {
  const [, ...body] = rows;
  // Number → the file row it first appeared on (0 = already in the campaign).
  const seen = new Map([...existingPhones].map((p) => [p, 0]));
  const preview: ImportPreview = { valid: [], unique: [], invalid: [], duplicates: [] };
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

  body.forEach((cells, i) => {
    const get = (field: ContactField) => clean(cells[mapping.findIndex((t) => t.kind === 'field' && t.field === field)]);
    const custom: Record<string, string> = {};
    mapping.forEach((t, col) => {
      const key = columnCustomKey(t);
      const v = clean(cells[col]);
      if (key && v) custom[key] = v;
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
    const contact: ImportContact = {
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
    };
    preview.valid.push(contact);
    const firstRow = seen.get(phone.e164);
    if (firstRow == null) {
      seen.set(phone.e164, i + 2);
      preview.unique.push(contact);
    } else {
      preview.duplicates.push({ row: i + 2, phone: rawPhone, name: fullName ?? '', reason: firstRow === 0 ? 'Already a contact for this client' : `Same number as row ${firstRow}` });
    }
  });

  return preview;
}
