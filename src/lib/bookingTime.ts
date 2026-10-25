/** Time zones a meeting can be booked in. */
export const ZONES = [
  { tz: 'Australia/Sydney', locale: 'en-AU', label: 'Sydney / Melbourne' },
  { tz: 'Australia/Brisbane', locale: 'en-AU', label: 'Brisbane' },
  { tz: 'Australia/Adelaide', locale: 'en-AU', label: 'Adelaide' },
  { tz: 'Australia/Perth', locale: 'en-AU', label: 'Perth' },
  { tz: 'Pacific/Auckland', locale: 'en-NZ', label: 'New Zealand' },
];

/** "2026-10-30", "14:30", Sydney → "2:30pm AEDT" (the zone abbreviation for that date, so DST is right). */
export function timeBookedText(date: string, time: string, tz: string): string {
  if (!time) return '';
  const zone = ZONES.find((z) => z.tz === tz) ?? ZONES[0];
  const [h, m] = time.split(':').map(Number);
  const hour12 = h % 12 || 12;
  const at = new Date(`${date || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const abbr = new Intl.DateTimeFormat(zone.locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${hour12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'} ${abbr}`.trim();
}
