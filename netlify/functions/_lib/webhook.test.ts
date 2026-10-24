import twilio from 'twilio';
import { afterEach, describe, expect, it } from 'vitest';
import { twilioSignature, verifyTwilioWebhook } from './webhook';

const TOKEN = 'test-auth-token-1234';
const URL_ = 'https://dialer.maronly.com.au/api/twilio/voice?callId=abc';
const PARAMS = { CallSid: 'CA123', From: 'client:00000000-0000-0000-0000-000000000001', contactId: 'x y&z', Digits: '1234#' };

const request = (signature: string, url = URL_, params: Record<string, string> = PARAMS) =>
  new Request(url, { method: 'POST', headers: { 'x-twilio-signature': signature, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

describe('Twilio webhook signatures', () => {
  afterEach(() => delete process.env.TWILIO_AUTH_TOKEN);

  it("matches the Twilio SDK's own validation", () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS);
    expect(twilio.validateRequest(TOKEN, sig, URL_, PARAMS)).toBe(true);
    expect(twilio.getExpectedTwilioSignature(TOKEN, URL_, PARAMS)).toBe(sig);
  });

  it('accepts a correctly signed request and returns its params', async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    await expect(verifyTwilioWebhook(request(twilioSignature(TOKEN, URL_, PARAMS)))).resolves.toEqual(PARAMS);
  });

  it('rejects a wrong or missing signature, or tampered params', async () => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    await expect(verifyTwilioWebhook(request('bogus'))).rejects.toThrow('Invalid signature');
    await expect(verifyTwilioWebhook(request(''))).rejects.toThrow('Invalid signature');
    const sig = twilioSignature(TOKEN, URL_, PARAMS);
    await expect(verifyTwilioWebhook(request(sig, URL_, { ...PARAMS, contactId: 'other' }))).rejects.toThrow('Invalid signature');
  });
});
