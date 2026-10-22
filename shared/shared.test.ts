import { describe, expect, it } from 'vitest';
import { buildImport, guessMapping, parseCsv } from './csv';
import { buildLeadFields, todayInSydney, validateLead, type LeadInput } from './leads';
import { contactOutcome } from './outcomes';
import { formatPhone, normalizePhone } from './phone';
import { numberSearchPattern } from './numberSearch';
import { shouldTranscribe } from './pickup';

describe('normalizePhone', () => {
  it.each([
    ['0412 345 678', '+61412345678'],
    ['+61 412 345 678', '+61412345678'],
    ['61412345678', '+61412345678'],
    ['412345678', '+61412345678'],
    ['(04) 1234-5678', '+61412345678'],
    ['0061412345678', '+61412345678'],
    [61412345678, '+61412345678'],
    ['021 123 4567', '+64211234567'],
    ['+64 21 123 4567', '+64211234567'],
    ['6421234567', '+6421234567'],
    ['+64 274 123 456', '+64274123456'],
    ['+64 29 876 5432', '+64298765432'],
  ])('%s → %s', (raw, e164) => {
    expect(normalizePhone(raw)).toMatchObject({ ok: true, e164 });
  });

  it.each([
    ['02 9876 5432', /landline/], // Sydney landline
    ['03 9123 4567', /landline/],
    ['0274 123 456', /landline/], // ambiguous locally: NZ 027 mobiles need +64
    ['1300 123 456', /mobile/],
    ['+44 7700 900123', /AU\/NZ/],
    ['+1 415 555 0100', /AU\/NZ/],
    ['', /No phone/],
    ['12', /mobile/],
  ])('rejects %s', (raw, reason) => {
    const r = normalizePhone(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('formats for display', () => {
    expect(formatPhone('+61412345678')).toBe('0412 345 678');
    expect(formatPhone(null)).toBe('—');
  });
});

describe('contactOutcome', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const opts = { maxAttempts: 3, retryAfterMinutes: 60, now };

  it('retries no answers until the attempt limit', () => {
    expect(contactOutcome('No Answer', { ...opts, attemptsAfterThisCall: 1 })).toEqual({ status: 'callback', nextAttemptAt: new Date('2026-10-22T01:00:00Z') });
    expect(contactOutcome('Left Voicemail', { ...opts, attemptsAfterThisCall: 3 })).toEqual({ status: 'done', nextAttemptAt: null });
  });

  it('takes everything else out of the queue', () => {
    expect(contactOutcome('Do Not Call', { ...opts, attemptsAfterThisCall: 1 }).status).toBe('do_not_call');
    expect(contactOutcome('Wrong Number', { ...opts, attemptsAfterThisCall: 1 }).status).toBe('bad_number');
    expect(contactOutcome('Disconnected Number', { ...opts, attemptsAfterThisCall: 1 }).status).toBe('bad_number');
    expect(contactOutcome('Interested - Appointment Set', { ...opts, attemptsAfterThisCall: 1 }).status).toBe('done');
    expect(contactOutcome('Not Interested', { ...opts, attemptsAfterThisCall: 1 }).status).toBe('done');
  });
});

describe('leads', () => {
  const lead: LeadInput = { fullName: ' Jane Doe ', email: 'jane@acme.com', phone: '+61412345678', notes: 'Call back Tues', nextFollowUp: '2026-10-28' };
  const ctx = { airtableClientId: 'recABC', campaignName: 'Kintell Oct', linkedin: 'https://linkedin.com/in/jane', website: null, todaySydney: '2026-10-22' };

  it('builds a Nurture lead for Needs Follow-Up', () => {
    expect(buildLeadFields('Interested - Needs Follow-Up', lead, ctx)).toEqual({
      'Prospect Full Name': 'Jane Doe',
      'Prospect Email': 'jane@acme.com',
      'Phone Number': '+61412345678',
      Client: ['recABC'],
      Channel: 'Cold Call',
      'Campaign Name': 'Kintell Oct',
      'Notes (Maronly)': 'Call back Tues',
      'Linkedin Profile': 'https://linkedin.com/in/jane',
      'Record Status': 'Open',
      Stage: 'Nurture',
      'Next follow up': '2026-10-28',
    });
  });

  it('builds a Booking lead for Appointment Set', () => {
    const fields = buildLeadFields('Interested - Appointment Set', { ...lead, bookedFor: '2026-10-30', timeBookedFor: '2:30pm AEDT' }, ctx);
    expect(fields).toMatchObject({ Stage: 'Booking', 'Booked For': '2026-10-30', 'Time Booked for (plain text)': '2:30pm AEDT', 'Date Booked': '2026-10-22' });
    expect(fields).not.toHaveProperty('Next follow up');
    expect(fields).not.toHaveProperty('Website');
  });

  it('validates', () => {
    expect(validateLead('Interested - Needs Follow-Up', lead)).toEqual([]);
    expect(validateLead('Interested - Needs Follow-Up', { ...lead, fullName: '', email: 'nope' })).toHaveLength(2);
    expect(validateLead('Interested - Appointment Set', lead)).toEqual(['Booked for date is required.', 'Time booked for is required.']);
  });

  it('gives the Sydney date', () => {
    // 14:00 UTC on the 22nd is already the 23rd in Sydney (AEDT, UTC+11).
    expect(todayInSydney(new Date('2026-10-22T14:00:00Z'))).toBe('2026-10-23');
  });
});

describe('csv import', () => {
  it('parses quotes, escaped quotes, newlines and CRLF', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('guesses columns', () => {
    expect(guessMapping(['First Name', 'Last Name', 'Mobile Phone', 'Email Address', 'Company Website', 'Company', 'Job Title', 'LinkedIn URL', 'Industry'])).toEqual([
      'first_name', 'last_name', 'phone', 'email', 'website', 'company', 'title', 'linkedin', 'custom',
    ]);
  });

  it('builds contacts, rejecting bad numbers and duplicates', () => {
    const rows = parseCsv('Name,Phone,Company,Industry\nJane Doe,0412 345 678,Acme,SaaS\nBob,02 9876 5432,Beta,\nJane again,+61412345678,Acme,\nKim,0423 456 789,,Fin\nOld,0499 999 999,,');
    const preview = buildImport(rows, guessMapping(rows[0]), new Set(['+61499999999']));
    expect(preview.valid.map((c) => [c.full_name, c.phone_e164, c.first_name])).toEqual([
      ['Jane Doe', '+61412345678', 'Jane'],
      ['Kim', '+61423456789', 'Kim'],
    ]);
    expect(preview.valid[0].custom).toEqual({ Industry: 'SaaS' });
    expect(preview.invalid).toEqual([{ row: 3, phone: '02 9876 5432', name: 'Bob', reason: 'Looks like an AU landline (use +64 for NZ mobiles)' }]);
    expect(preview.duplicates).toBe(2);
  });
});

describe('shouldTranscribe', () => {
  it('skips machines and very short calls', () => {
    expect(shouldTranscribe({ kind: 'call', answeredBy: 'human', durationS: 40 })).toBe(true);
    expect(shouldTranscribe({ kind: 'call', answeredBy: 'machine_end_beep', durationS: 40 })).toBe(false);
    expect(shouldTranscribe({ kind: 'call', answeredBy: null, durationS: 3 })).toBe(false);
    expect(shouldTranscribe({ kind: 'voicemail', answeredBy: null, durationS: 10 })).toBe(true);
  });
});

describe('numberSearchPattern', () => {
  it('builds Twilio contains patterns', () => {
    expect(numberSearchPattern('888', 'anywhere')).toEqual({ ok: true, contains: '888' });
    expect(numberSearchPattern('0488', 'start')).toEqual({ ok: true, contains: '488******' });
    expect(numberSearchPattern('+61 488', 'start')).toEqual({ ok: true, contains: '488******' });
    expect(numberSearchPattern('488', 'start')).toEqual({ ok: true, contains: '488******' });
    expect(numberSearchPattern('8 888', 'end')).toEqual({ ok: true, contains: '*****8888' });
    expect(numberSearchPattern('', 'end')).toEqual({ ok: true, contains: null });
  });

  it('rejects searches that cannot match a mobile', () => {
    expect(numberSearchPattern('02', 'start').ok).toBe(false);
    expect(numberSearchPattern('1234567890', 'anywhere').ok).toBe(false);
  });
});
