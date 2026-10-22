import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/mobile';

// We only call Australian (+61) and New Zealand (+64) mobiles. The `mobile` metadata build of libphonenumber
// only treats mobile numbers as valid, so landlines, 1300 numbers etc. are rejected here.

const COUNTRIES: CountryCode[] = ['AU', 'NZ'];

export type PhoneResult = { ok: true; e164: string; country: 'AU' | 'NZ' } | { ok: false; reason: string };

export function normalizePhone(raw: string | number | null | undefined): PhoneResult {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: 'No phone number' };

  // Strip formatting, keep a leading +. Spreadsheets often drop the + ("61412345678") or the leading 0 ("412345678").
  let cleaned = input.replace(/(?!^\+)[^\d]/g, '');
  if (/^(61|64)\d{8,10}$/.test(cleaned)) cleaned = `+${cleaned}`;
  if (/^00(61|64)/.test(cleaned)) cleaned = `+${cleaned.slice(2)}`;
  if (/^4\d{8}$/.test(cleaned)) cleaned = `0${cleaned}`;
  if (/^2\d{7,9}$/.test(cleaned)) cleaned = `0${cleaned}`; // NZ mobile without the 0

  // Written locally, an AU landline (02 9876 5432) is also a valid NZ mobile (029 876 5432). Our lists are mostly
  // Australian, so treat that shape as an AU landline; NZ mobiles starting 027/028/029 need +64 in the list.
  if (/^0[2378][2-9]\d{7}$/.test(cleaned)) return { ok: false, reason: 'Looks like an AU landline (use +64 for NZ mobiles)' };

  for (const country of COUNTRIES) {
    const parsed = parsePhoneNumberFromString(cleaned, country);
    if (parsed?.isValid() && (parsed.country === 'AU' || parsed.country === 'NZ')) {
      return { ok: true, e164: parsed.number, country: parsed.country };
    }
  }

  const parsed = parsePhoneNumberFromString(cleaned, 'AU');
  if (parsed?.country && parsed.country !== 'AU' && parsed.country !== 'NZ') return { ok: false, reason: 'Not an AU/NZ number' };
  return { ok: false, reason: 'Not a valid AU/NZ mobile' };
}

/** +61412345678 → 0412 345 678; +6421234567 → 021 234 567. Anything unparseable is returned as-is. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatNational() : e164;
}
