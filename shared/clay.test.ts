import { describe, expect, it } from 'vitest';
import { clayLinkValid, clayTableId, findsContact, indexRows, keyColumns, linkedinHandle, websiteDomain } from './clay';

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
});
