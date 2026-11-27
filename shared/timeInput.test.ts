import { describe, expect, it } from 'vitest';
import { parseTime, TIME_OPTIONS, timeLabel } from './timeInput';

describe('typed times', () => {
  it('reads times the way people type them', () => {
    expect(parseTime('9')).toBe('09:00');
    expect(parseTime('9am')).toBe('09:00');
    expect(parseTime('930')).toBe('09:30');
    expect(parseTime('9:30')).toBe('09:30');
    expect(parseTime('2.30 pm')).toBe('14:30');
    expect(parseTime('230p')).toBe('14:30');
    expect(parseTime('2:30')).toBe('14:30'); // no am/pm: 1–7 is the afternoon
    expect(parseTime('14:30')).toBe('14:30');
    expect(parseTime('12')).toBe('12:00');
    expect(parseTime('12am')).toBe('00:00');
    expect(parseTime('noon')).toBe('12:00');
    expect(parseTime(' 11:45 AM ')).toBe('11:45');
  });

  it('refuses what is not a time', () => {
    for (const bad of ['', 'abc', '25:00', '9:75', '13pm', '1234567']) expect(parseTime(bad)).toBeNull();
  });

  it('labels and lists times', () => {
    expect(timeLabel('14:05')).toBe('2:05 pm');
    expect(timeLabel('00:30')).toBe('12:30 am');
    expect(TIME_OPTIONS[0]).toBe('06:00');
    expect(TIME_OPTIONS.at(-1)).toBe('21:00');
    expect(TIME_OPTIONS).toHaveLength(61);
  });
});
