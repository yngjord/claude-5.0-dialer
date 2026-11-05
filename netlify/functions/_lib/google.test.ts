import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { authUrl, decrypt, encrypt, inviteEventId, sign, verify } from './google';

beforeAll(() => {
  process.env.GOOGLE_TOKEN_KEY = randomBytes(32).toString('base64');
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
});

describe('google', () => {
  it('encrypts refresh tokens so only this key can read them', () => {
    const sealed = encrypt('1//refresh-token');
    expect(sealed).not.toContain('refresh-token');
    expect(decrypt(sealed)).toBe('1//refresh-token');
    expect(encrypt('1//refresh-token')).not.toBe(sealed); // fresh IV each time
    const [v, iv, tag, ct] = sealed.split('.');
    const tampered = [v, iv, tag, ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA')].join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('signs connect links and rejects altered or expired ones', () => {
    const t = sign({ c: 'recABCDEFGHIJKLMN' }, 60);
    expect(verify<{ c: string }>(t)?.c).toBe('recABCDEFGHIJKLMN');
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ c: 'recOTHERCLIENT0000', exp: 9_999_999_999 })).toString('base64url');
    expect(verify(`${forged}.${sig}`)).toBeNull();
    expect(verify(`${payload}.x${sig.slice(1)}`)).toBeNull();
    expect(verify(sign({ c: 'x' }, -1))).toBeNull();
    expect(verify(null)).toBeNull();
  });

  it('asks Google for exactly the calendar scopes we disclose, offline', () => {
    const url = new URL(authUrl('https://dialer.maronly.com.au', 'state123'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://dialer.maronly.com.au/api/google/callback');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ]);
  });

  it('makes a valid, stable Google event id per call', () => {
    const id = inviteEventId('8EBC1081-1159-46ec-9cc2-6ef6a77dacbd');
    expect(id).toBe('md8ebc1081115946ec9cc26ef6a77dacbd');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});
