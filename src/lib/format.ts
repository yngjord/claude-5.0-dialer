const TZ = 'Australia/Sydney';

/** e.g. "10 Oct, 1:21 pm" (Sydney time), or "10 Oct, 1:21 pm AEDT" with `withZone`; the year is added when it isn't this year. */
export function formatDateTime(value: string | null | undefined, { withZone = false } = {}): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const year = d.toLocaleDateString('en-AU', { timeZone: TZ, year: 'numeric' });
  const sameYear = year === new Date().toLocaleDateString('en-AU', { timeZone: TZ, year: 'numeric' });
  const date = d.toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...(withZone ? { timeZoneName: 'short' } : {}) });
  return `${date}, ${time}`;
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

/** Today's date in Sydney, YYYY-MM-DD. */
export const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** YYYY-MM-DD shifted by n days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant a Sydney calendar day (YYYY-MM-DD) starts, as an ISO timestamp. Handles daylight saving. */
export function sydneyMidnight(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const offset = new Date(guess.toLocaleString('en-US', { timeZone: TZ })).getTime() - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

/** Start of today, n days back, in Sydney time, as an ISO timestamp. */
export const sydneyDayStart = (daysAgo = 0) => sydneyMidnight(addDays(sydneyToday(), -daysAgo));

export const domainOf = (url: string) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
export const withProtocol = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);
