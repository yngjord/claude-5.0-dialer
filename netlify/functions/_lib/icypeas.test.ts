import { describe, expect, it } from 'vitest';
import { headcountOf, slugOf } from './icypeas';

describe('Icypeas results', () => {
  it('stores the count, or the range when the count is unknown', () => {
    expect(headcountOf({ numberOfEmployees: 62, headcountRange: '50-100' })).toBe('62');
    expect(headcountOf({ numberOfEmployees: -1, headcountRange: '11-50' })).toBe('11-50');
    expect(headcountOf({})).toBeNull();
  });
  it('matches results by LinkedIn slug', () => {
    expect(slugOf('https://www.linkedin.com/company/Acme-Co/')).toBe('acme-co');
    expect(slugOf('https://linkedin.com/school/some-school')).toBe('some-school');
    expect(slugOf('https://linkedin.com/in/jane')).toBeNull();
  });
});
