const TZ = 'Australia/Sydney';

/** e.g. "10 Oct, 1:21 pm" (Sydney time); the year is added when it isn't this year. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const year = d.toLocaleDateString('en-AU', { timeZone: TZ, year: 'numeric' });
  const sameYear = year === new Date().toLocaleDateString('en-AU', { timeZone: TZ, year: 'numeric' });
  const date = d.toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

/** 75 → "1:15"; 3725 → "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 5400 → "1h 30m"; 300 → "5m". */
export function formatTalkTime(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

/** Start of today, n days back, in Sydney time, as an ISO timestamp. */
export function sydneyDayStart(daysAgo = 0): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const [y, m, d] = today.split('-').map(Number);
  // Find the UTC instant of Sydney midnight by checking the offset at that date.
  const guess = new Date(Date.UTC(y, m - 1, d - daysAgo));
  const offset = new Date(guess.toLocaleString('en-US', { timeZone: TZ })).getTime() - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export const domainOf = (url: string) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
export const withProtocol = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);
