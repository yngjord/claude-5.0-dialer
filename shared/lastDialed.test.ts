import { describe, expect, it } from 'vitest';
import { daysSince, linkedinPattern, parseLastDialedRequest } from './lastDialed';

describe('last-dialed lookup', () => {
  it('standardises unformatted numbers', () => {
    for (const phone of ['0412 345 678', '61412345678', '+61 412 345 678', 412345678, '0061412345678']) {
      const r = parseLastDialedRequest({ client: 'Morfless', phone });
      expect(r.ok && r.lookup.phone).toBe('+61412345678');
    }
  });

  it('takes a LinkedIn profile, alone or with a number', () => {
    const r = parseLastDialedRequest({
      client: 'Morfless',
      linkedin: 'https://www.linkedin.com/in/SteveMann/?utm=x',
    });
    expect(r.ok && r.lookup).toEqual({
      client: 'Morfless',
      clientIsAirtableId: false,
      phone: null,
      linkedin: 'stevemann',
    });
    // A bad number doesn't block a good LinkedIn lookup.
    const both = parseLastDialedRequest({
      client: 'Morfless',
      phone: '12',
      linkedin: 'linkedin.com/in/stevemann',
    });
    expect(both.ok && both.lookup.linkedin).toBe('stevemann');
  });

  it('recognises an Airtable client id', () => {
    const r = parseLastDialedRequest({
      client: ' recABCDEFGHIJKLMN ',
      phone: '0412345678',
    });
    expect(r.ok && r.lookup.clientIsAirtableId).toBe(true);
  });

  it('explains what is missing or wrong', () => {
    expect(parseLastDialedRequest({ phone: '0412345678' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('"client"'),
    });
    expect(parseLastDialedRequest({ client: 'Morfless' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('"phone" or "linkedin"'),
    });
    expect(parseLastDialedRequest({ client: 'Morfless', phone: '12' })).toMatchObject({ ok: false, error: expect.stringContaining('"12"') });
    expect(
      parseLastDialedRequest({
        client: 'Morfless',
        linkedin: 'linkedin.com/company/acme',
      }),
    ).toMatchObject({ ok: false });
    expect(parseLastDialedRequest(null)).toMatchObject({ ok: false });
  });

  it('matches the whole profile handle, not a longer one', () => {
    const re = new RegExp(linkedinPattern('john.smith'), 'i');
    expect(re.test('https://www.linkedin.com/in/John.Smith/')).toBe(true);
    expect(re.test('linkedin.com/in/john.smith')).toBe(true);
    expect(re.test('linkedin.com/in/john.smith?x=1')).toBe(true);
    expect(re.test('linkedin.com/in/john.smithson/')).toBe(false);
    expect(re.test('linkedin.com/in/johnxsmith/')).toBe(false);
  });

  it('counts whole days since the call', () => {
    expect(daysSince('2026-11-20T10:00:00Z', new Date('2026-11-25T09:00:00Z'))).toBe(4);
    expect(daysSince('2026-11-26T10:00:00Z', new Date('2026-11-25T09:00:00Z'))).toBe(0);
  });
});
