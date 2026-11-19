import { describe, expect, it } from 'vitest';
import { bucketSize, makeBuckets, rangeDays } from './trendBuckets';

const TODAY = '2026-11-19'; // a Thursday
const r = (preset: string, from = '', to = '') => ({ preset, from, to }) as Parameters<typeof rangeDays>[0];

describe('trend buckets', () => {
  it('picks a bucket size from the range length', () => {
    expect(bucketSize(r('today'), TODAY)).toBe('hour');
    expect(bucketSize(r('7'), TODAY)).toBe('day');
    expect(bucketSize(r('month'), TODAY)).toBe('day');
    expect(bucketSize(r('90'), TODAY)).toBe('week');
    expect(bucketSize(r('all'), TODAY)).toBe('month');
    expect(bucketSize(r('custom', '2026-01-01', '2026-11-19'), TODAY)).toBe('month');
    expect(bucketSize(r('custom', '2026-11-19', '2026-11-19'), TODAY)).toBe('hour');
  });

  it('works out last month', () => {
    expect(rangeDays(r('lastMonth'), TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangeDays(r('lastMonth'), '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('lists every day, including empty ones', () => {
    const b = makeBuckets(r('7'), 'day', [], TODAY);
    expect(b.map((x) => x.key)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  });

  it('starts weeks on Monday, matching Postgres date_trunc', () => {
    const b = makeBuckets(r('90'), 'week', [], TODAY);
    expect(b[0].key).toBe('2026-08-17');
    expect(b.at(-1)!.key).toBe('2026-11-16');
    expect(new Date(`${b[0].key}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it('starts all-time months at the first month with calls', () => {
    const b = makeBuckets(r('all'), 'month', ['2026-10-01', '2026-11-01'], TODAY);
    expect(b.map((x) => x.key)).toEqual(['2026-10-01', '2026-11-01']);
  });

  it('shows business hours for a day, widened to hours with calls', () => {
    const b = makeBuckets(r('today'), 'hour', ['2026-11-19 07', '2026-11-19 12'], TODAY);
    expect(b[0].key).toBe('2026-11-19 07');
    expect(b.at(-1)!.key).toBe('2026-11-19 18');
    expect(b[0].axis).toBe('7am');
  });
});
