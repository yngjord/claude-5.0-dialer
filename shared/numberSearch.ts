// Twilio's `contains` filter for available numbers: digits plus `*` for "any one digit". A bare run of digits
// matches anywhere; padding it with `*` to the full length of the number pins it to the start or end, which is how
// Twilio's console offers "starts with" / "ends with". AU mobiles are 9 digits after +61 (4xx xxx xxx).

export const NUMBER_MATCHES = ['anywhere', 'start', 'end'] as const;
export type NumberMatch = (typeof NUMBER_MATCHES)[number];

const AU_MOBILE_DIGITS = 9;

export type NumberPattern = { ok: true; contains: string | null } | { ok: false; reason: string };

/** Builds the `contains` pattern from what the admin typed. Null = no filter. */
export function numberSearchPattern(input: string, match: NumberMatch): NumberPattern {
  let digits = input.replace(/\D/g, '');
  // Typed as written locally ("0488…") or with the country code ("61488…"): drop to the 9-digit number.
  if (match === 'start') digits = digits.replace(/^61(?=4)/, '').replace(/^0(?=4)/, '');
  if (!digits) return { ok: true, contains: null };
  if (digits.length > AU_MOBILE_DIGITS) return { ok: false, reason: "That's more digits than an Australian mobile number has." };

  if (match === 'anywhere') return { ok: true, contains: digits };
  if (match === 'start') {
    if (!digits.startsWith('4')) return { ok: false, reason: 'Australian mobiles start with 04, so a number starting with that won’t exist.' };
    return { ok: true, contains: digits.padEnd(AU_MOBILE_DIGITS, '*') };
  }
  return { ok: true, contains: digits.padStart(AU_MOBILE_DIGITS, '*') };
}
