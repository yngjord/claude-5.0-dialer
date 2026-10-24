// Searching Twilio's AU mobile numbers by digits. Twilio's `contains` filter matches the digits anywhere in the
// number (its `*` wildcards don't pin them to the start or end), so we ask Twilio for numbers containing the digits
// and then keep only the ones that start or end with them. AU mobiles are 9 digits after +61 (4xx xxx xxx).

export const NUMBER_MATCHES = ['anywhere', 'start', 'end'] as const;
export type NumberMatch = (typeof NUMBER_MATCHES)[number];

const AU_MOBILE_DIGITS = 9;

/** `digits`: what to look for in the 9-digit national number. `contains`: the filter to send Twilio. Null = no filter. */
export type NumberPattern = { ok: true; digits: string | null; contains: string | null } | { ok: false; reason: string };

/** Turns what the admin typed into the digits to search for. */
export function numberSearchPattern(input: string, match: NumberMatch): NumberPattern {
  let digits = input.replace(/\D/g, '');
  // Typed as written locally ("0488…") or with the country code ("61488…"): drop to the 9-digit number.
  if (match === 'start') digits = digits.replace(/^61(?=4)/, '').replace(/^0(?=4)/, '');
  if (!digits) return { ok: true, digits: null, contains: null };
  if (digits.length > AU_MOBILE_DIGITS) return { ok: false, reason: "That's more digits than an Australian mobile number has." };
  if (match === 'start' && !digits.startsWith('4')) return { ok: false, reason: 'Australian mobiles start with 04, so a number starting with that won’t exist.' };
  return { ok: true, digits, contains: digits };
}

/** Whether a number Twilio returned (E.164, e.g. +61485077744) really matches the search. */
export function matchesNumberSearch(e164: string, digits: string | null, match: NumberMatch): boolean {
  if (!digits) return true;
  const national = e164.replace(/\D/g, '').replace(/^61/, '');
  return match === 'start' ? national.startsWith(digits) : match === 'end' ? national.endsWith(digits) : national.includes(digits);
}
