import { describe, expect, it } from 'vitest';
import { buildImport, customFieldKey, guessMapping, parseCsv } from './csv';
import { buildLeadFields, LEAD_FIELDS as F, recordingLink, todayInSydney, validateLead, validateManualBooking, type LeadInput } from './leads';
import { contactOutcome } from './outcomes';
import { formatPhone, normalizePhone } from './phone';
import { matchesNumberSearch, numberSearchPattern } from './numberSearch';
import { shouldTranscribe } from './pickup';
import { buildBlocklistFields } from './blocklist';
import { decodeEntities } from './text';
import { zonedTimeToUtc } from './time';

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
  it('takes every contact out of the queue', () => {
    expect(contactOutcome('No Answer')).toBe('done');
    expect(contactOutcome('Left Voicemail')).toBe('done');
    expect(contactOutcome('Do Not Call')).toBe('do_not_call');
    expect(contactOutcome('Wrong Number')).toBe('bad_number');
    expect(contactOutcome('Disconnected Number')).toBe('bad_number');
    expect(contactOutcome('Interested - Appointment Set')).toBe('done');
  });
});

describe('leads', () => {
  const lead: LeadInput = { fullName: ' Jane Doe ', email: 'jane@acme.com', phone: '+61412345678', notes: 'Call back Tues' };
  const ctx = { airtableClientId: 'recABC', campaignName: 'Kintell Oct', linkedin: 'https://linkedin.com/in/jane', website: null, todaySydney: '2026-10-22', attributedTo: 'tom@maronly.com', recordingLink: 'https://dialer.maronly.com.au/r/abc.mp3' };

  it('builds a Nurture lead for Needs Follow-Up', () => {
    expect(buildLeadFields('Interested - Needs Follow-Up', lead, ctx)).toEqual({
      [F.fullName]: 'Jane Doe',
      [F.email]: 'jane@acme.com',
      [F.phone]: '+61412345678',
      [F.client]: ['recABC'],
      [F.channel]: 'Cold Call',
      [F.campaignName]: 'Kintell Oct',
      [F.notes]: 'Call back Tues',
      [F.linkedin]: 'https://linkedin.com/in/jane',
      [F.recordStatus]: 'Open',
      [F.callRecordingLink]: 'https://dialer.maronly.com.au/r/abc.mp3',
      [F.stage]: 'Nurture',
      [F.nextFollowUp]: '2026-10-22',
      fldKG3QEhKosSdvxc: 'tom@maronly.com',
    });
  });

  it('builds a Booking lead for Appointment Set', () => {
    const fields = buildLeadFields('Interested - Appointment Set', { ...lead, bookedFor: '2026-10-30', timeBookedFor: '2:30pm AEDT' }, ctx);
    expect(fields).toMatchObject({ [F.stage]: 'Booking', [F.dateBookedFor]: '2026-10-30', [F.timeBookedFor]: '2:30pm AEDT', [F.dateBookingMade]: '2026-10-22' });
    expect(fields).not.toHaveProperty(F.nextFollowUp);
    expect(fields).not.toHaveProperty(F.website);
  });

  it('validates hand-added bookings like the Airtable form', () => {
    const booking = {
      airtableClientId: 'recABCDEFGHIJKLMN',
      campaignName: 'Kintell Oct',
      linkedin: 'https://linkedin.com/in/jane',
      lead: { ...lead, bookedFor: '2026-10-30', timeBookedFor: '2:30pm AEDT' },
    };
    expect(validateManualBooking(booking)).toEqual([]);
    expect(validateManualBooking({ ...booking, airtableClientId: '', linkedin: ' ', lead: { ...lead, phone: '' } })).toEqual([
      'Choose a client.',
      'Phone number is required.',
      'LinkedIn profile is required.',
      'Booked for date is required.',
      'Time booked for is required.',
    ]);
    const fields = buildLeadFields('Interested - Appointment Set', booking.lead, { ...ctx, recordingLink: undefined });
    expect(fields).not.toHaveProperty(F.callRecordingLink);
    expect(fields).toMatchObject({ [F.stage]: 'Booking', [F.channel]: 'Cold Call' });
  });

  it('builds permanent recording links', () => {
    expect(recordingLink('https://dialer.maronly.com.au/', '3f9c')).toBe('https://dialer.maronly.com.au/r/3f9c.mp3');
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
    const f = (field: string) => ({ kind: 'field', field });
    expect(guessMapping(['First Name', 'Last Name', 'Mobile Phone', 'Email Address', 'Company Website', 'Company', 'Job Title', 'LinkedIn URL', 'Industry', ''])).toEqual([
      f('first_name'), f('last_name'), f('phone'), f('email'), f('website'), f('company'), f('title'), f('linkedin'),
      { kind: 'new', label: 'Industry' }, { kind: 'skip' },
    ]);
  });

  it('maps saved custom fields by name, key or a header used before', () => {
    const saved = [
      { key: 'employee_count', label: 'Employee count', aliases: ['headcount'] },
      { key: 'industry', label: 'Industry', aliases: [] },
    ];
    expect(guessMapping(['Phone', 'EMPLOYEE COUNT', 'Industry'], saved).slice(1)).toEqual([
      { kind: 'custom', key: 'employee_count' },
      { kind: 'custom', key: 'industry' },
    ]);
    expect(guessMapping(['Head-count'], saved)).toEqual([{ kind: 'custom', key: 'employee_count' }]);
    expect(guessMapping(['Revenue'], saved)).toEqual([{ kind: 'new', label: 'Revenue' }]);
    expect(customFieldKey(' Annual Revenue ($) ')).toBe('annual_revenue');
  });

  it('builds contacts, rejecting bad numbers and flagging duplicates', () => {
    const rows = parseCsv('Name,Phone,Company,Industry\nJane Doe,0412 345 678,Acme,SaaS\nBob,02 9876 5432,Beta,\nJane again,+61412345678,Acme,\nKim,0423 456 789,,Fin\nOld,0499 999 999,,');
    const preview = buildImport(rows, guessMapping(rows[0]), new Set(['+61499999999']));
    expect(preview.unique.map((c) => [c.full_name, c.phone_e164, c.first_name])).toEqual([
      ['Jane Doe', '+61412345678', 'Jane'],
      ['Kim', '+61423456789', 'Kim'],
    ]);
    expect(preview.valid.map((c) => c.full_name)).toEqual(['Jane Doe', 'Jane again', 'Kim', 'Old']);
    expect(preview.valid[0].custom).toEqual({ industry: 'SaaS' });
    expect(preview.invalid).toEqual([{ row: 3, phone: '02 9876 5432', name: 'Bob', reason: 'Looks like an AU landline (use +64 for NZ mobiles)' }]);
    expect(preview.duplicates).toEqual([
      { row: 4, phone: '+61412345678', name: 'Jane again', reason: 'Same number as row 2' },
      { row: 6, phone: '0499 999 999', name: 'Old', reason: 'Already a contact for this client' },
    ]);
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
  it('works out the digits to search for', () => {
    expect(numberSearchPattern('888', 'anywhere')).toEqual({ ok: true, digits: '888', contains: '888' });
    expect(numberSearchPattern('0488', 'start')).toEqual({ ok: true, digits: '488', contains: '488' });
    expect(numberSearchPattern('+61 488', 'start')).toEqual({ ok: true, digits: '488', contains: '488' });
    expect(numberSearchPattern('8 888', 'end')).toEqual({ ok: true, digits: '8888', contains: '8888' });
    expect(numberSearchPattern('', 'end')).toEqual({ ok: true, digits: null, contains: null });
  });

  it('rejects searches that cannot match a mobile', () => {
    expect(numberSearchPattern('02', 'start').ok).toBe(false);
    expect(numberSearchPattern('1234567890', 'anywhere').ok).toBe(false);
  });

  it('keeps only numbers that really start or end with the digits', () => {
    // 777 in the middle: Twilio returns it for a "contains 777" search, but it doesn't end with 777.
    expect(matchesNumberSearch('+61485077744', '777', 'end')).toBe(false);
    expect(matchesNumberSearch('+61485094777', '777', 'end')).toBe(true);
    expect(matchesNumberSearch('+61485077744', '777', 'anywhere')).toBe(true);
    expect(matchesNumberSearch('+61488123456', '488', 'start')).toBe(true);
    expect(matchesNumberSearch('+61412488000', '488', 'start')).toBe(false);
    expect(matchesNumberSearch('+61412488000', null, 'start')).toBe(true);
  });
});

describe('zonedTimeToUtc', () => {
  it('turns a local date and time into the right instant, daylight saving included', () => {
    expect(zonedTimeToUtc('2026-10-30', '14:30', 'Australia/Sydney').toISOString()).toBe('2026-10-30T03:30:00.000Z'); // AEDT +11
    expect(zonedTimeToUtc('2026-07-01', '09:00', 'Australia/Sydney').toISOString()).toBe('2026-06-30T23:00:00.000Z'); // AEST +10
    expect(zonedTimeToUtc('2026-10-30', '14:30', 'Australia/Perth').toISOString()).toBe('2026-10-30T06:30:00.000Z'); // AWST +8
    expect(zonedTimeToUtc('2026-10-30', '14:30', 'Pacific/Auckland').toISOString()).toBe('2026-10-30T01:30:00.000Z'); // NZDT +13
  });
});

describe('contactOutcome: callback', () => {
  it('keeps the contact for a callback', () => {
    expect(contactOutcome('Callback')).toBe('callback');
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric HTML entities', () => {
    expect(decodeEntities('Shane O&#039;Dea')).toBe("Shane O'Dea");
    expect(decodeEntities('A &amp; B &lt;3 &quot;hi&quot; &#x27;x&#x27;')).toBe('A & B <3 "hi" \'x\'');
    expect(decodeEntities('no entities & stuff')).toBe('no entities & stuff');
  });
});

describe('buildBlocklistFields', () => {
  it('fills the Blocklists 2.0 record for a human pickup, leaving out empty values', () => {
    expect(
      buildBlocklistFields({ airtableClientId: 'recKintell', fullName: ' Jane Doe ', email: null, phone: '+61412345678', website: 'acme.com', linkedin: '', campaignName: 'Kintell Oct' }),
    ).toEqual({
      fldITStrOdTH309Ue: ['recKintell'],
      fldrYy4qGvbCl05uS: 'Person',
      fldtVGwN5uYiDZGN2: 'Cold Call pickup',
      fld2SoW3XttqFThAu: 'Jane Doe',
      fldQSBSPNfZ34GqFO: '+61412345678',
      fldtWCAxtp7sD5crB: 'acme.com',
      fldHRM9yswPCVPomf: 'Kintell Oct',
    });
  });
});
