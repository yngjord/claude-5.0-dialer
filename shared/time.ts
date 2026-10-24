/**
 * The instant a wall-clock date and time in a time zone happens, e.g. ("2026-10-30", "14:30", "Australia/Perth").
 * Handles daylight saving by asking Intl for the zone's offset at that moment.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(t))
        .map((p) => [p.type, p.value]),
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - t;
  };
  // Two passes: the offset can differ either side of a daylight saving change.
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first));
}
