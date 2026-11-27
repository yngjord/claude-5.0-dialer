/**
 * Reads a time typed the way people say it: "9", "9am", "930", "9:30", "2.30 pm", "230p", "14:30", "noon".
 * Returns "HH:MM" (24-hour) or null. Without am/pm, 1–7 means the afternoon (nobody books a call at 3 in the
 * morning) and 8–12 means the morning, except 12, which is midday.
 */
export function parseTime(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s === 'noon' || s === 'midday') return '12:00';
  const m = s.match(/^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'p' && h !== 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  } else if (h >= 1 && h <= 7 && !(m[1].length === 2 && m[1].startsWith('0'))) {
    // "3" or "3:30" means the afternoon; "03:30" typed with a leading zero is taken as written.
    h += 12;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "14:30" → "2:30 pm". */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** Every 15 minutes from 6 am to 9 pm. */
export const TIME_OPTIONS: string[] = Array.from({ length: (21 - 6) * 4 + 1 }, (_, i) => {
  const minutes = 6 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});
