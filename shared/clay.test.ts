import { describe, expect, it } from 'vitest';
import { clayLinkValid, clayTableId, findsContact, indexRows, keyColumns, linkedinHandle, lookupFilters, websiteDomain, type ClayFilter } from './clay';

describe('Clay tables', () => {
  it('reads the table id from a Clay URL or a bare id', () => {
    expect(clayTableId('https://app.clay.com/workspaces/226352/workbooks/wb_0tkg/tables/t_0tkgnvb46oXZ9bT3Zim/views/gv_0tmz')).toBe('t_0tkgnvb46oXZ9bT3Zim');
    expect(clayTableId(' t_0tkgnvb46oXZ9bT3Zim ')).toBe('t_0tkgnvb46oXZ9bT3Zim');
    expect(clayTableId('https://app.clay.com/workspaces/226352/tables/t_abc?x=1')).toBe('t_abc');
    expect(clayTableId('https://app.clay.com/workspaces/226352/workbooks/wb_0tkg')).toBeNull();
    expect(clayTableId('nonsense')).toBeNull();
  });

  it('normalises LinkedIn profiles and domains', () => {
    expect(linkedinHandle('https://www.linkedin.com/in/NeilDundon/')).toBe('neildundon');
    expect(linkedinHandle('linkedin.com/in/jos%C3%A9-p?utm=x')).toBe('josé-p');
    expect(linkedinHandle('https://linkedin.com/company/acme')).toBeNull();
    expect(websiteDomain('https://www.Acme.com.au/about')).toBe('acme.com.au');
    expect(websiteDomain('acme')).toBeNull();
  });

  it('finds the key columns whatever the table calls them', () => {
    expect(keyColumns(['Full Name', 'First Name', 'Company Linkedin URL', 'LinkedIn Profile', 'Domain/Website'])).toEqual({
      linkedin: 'LinkedIn Profile',
      firstName: 'First Name',
      domain: 'Domain/Website',
    });
    expect(keyColumns(['Person Linkedin Url', 'first_name', 'Company Domain'])).toEqual({ linkedin: 'Person Linkedin Url', firstName: 'first_name', domain: 'Company Domain' });
    expect(keyColumns(['Name']).linkedin).toBeNull();
  });

  it('matches contacts by LinkedIn, else first name + domain', () => {
    const index = indexRows([
      { linkedin: 'https://www.linkedin.com/in/neildundon/', firstName: 'Neil', domain: 'reddotrec.com.au' },
      { linkedin: null, firstName: 'Julie', domain: 'https://www.enticott.com.au' },
    ]);
    const c = { first_name: null, full_name: null, linkedin: null, website: null, email: null };
    expect(findsContact(index, { ...c, linkedin: 'http://linkedin.com/in/NeilDundon' })).toBe(true);
    expect(findsContact(index, { ...c, full_name: 'Julie Enticott', website: 'enticott.com.au' })).toBe(true);
    expect(findsContact(index, { ...c, first_name: 'Julie', email: 'julie@enticott.com.au' })).toBe(true);
    expect(findsContact(index, { ...c, first_name: 'Julie', website: 'other.com' })).toBe(false);
    expect(findsContact(index, c)).toBe(false);
  });

  it('needs at least half the contacts found', () => {
    expect(clayLinkValid(211, 211)).toBe(true);
    expect(clayLinkValid(50, 100)).toBe(true);
    expect(clayLinkValid(49, 100)).toBe(false);
    expect(clayLinkValid(0, 0)).toBe(false);
  });

  it('looks contacts up a few at a time instead of reading the whole table', () => {
    const cols = { linkedin: 'LinkedIn URL', firstName: 'First Name', domain: 'Company Website' };
    const base = { first_name: null, full_name: null, website: null, email: null };
    const contacts = [
      ...Array.from({ length: 12 }, (_, i) => ({ ...base, linkedin: `https://www.linkedin.com/in/person-${i}/` })),
      { ...base, linkedin: 'https://linkedin.com/in/NeilDundon' },
      { ...base, linkedin: null, first_name: 'Julie', website: 'https://www.enticott.com.au' },
      { ...base, linkedin: null, full_name: 'Sam Lee', email: 'sam@acme.io' },
      { ...base, linkedin: null }, // nothing to look up by
    ];
    const f = lookupFilters(contacts, cols);
    // 13 profiles in batches of 5 (3 requests), then the 2 name + domain contacts in one.
    expect(f).toHaveLength(4);
    const ors = f.map((x) => ('or' in x ? x.or : [x]));
    for (const o of ors) expect(o.length).toBeLessThanOrEqual(10);
    expect(ors[2]).toEqual([
      { field: 'LinkedIn URL', op: 'contains', value: '/in/person-10' },
      { field: 'LinkedIn URL', op: 'contains', value: '/in/person-11' },
      { field: 'LinkedIn URL', op: 'contains', value: '/in/NeilDundon' },
      { field: 'LinkedIn URL', op: 'contains', value: '/in/neildundon' },
    ]);
    expect(f[3]).toEqual({
      or: [
        { and: [{ field: 'First Name', op: '=', value: 'Julie' }, { field: 'Company Website', op: 'contains', value: 'enticott.com.au' }] },
        { and: [{ field: 'First Name', op: '=', value: 'Sam' }, { field: 'Company Website', op: 'contains', value: 'acme.io' }] },
      ],
    } satisfies ClayFilter);
    // No LinkedIn column: everyone with a name and domain is looked up that way.
    expect(lookupFilters(contacts, { ...cols, linkedin: null })).toHaveLength(1);
  });
});
