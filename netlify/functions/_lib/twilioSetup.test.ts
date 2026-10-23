import { describe, expect, it } from 'vitest';
import { runTwilioSetup } from './twilioSetup';

// A minimal fake of the Twilio client calls setup makes.
function fakeClient(opts: { appError?: unknown; intelligenceError?: unknown }) {
  const fail = (err: unknown) => () => Promise.reject(err);
  const client = {
    applications: Object.assign(() => ({ update: async () => ({ sid: 'AP1' }) }), {
      list: async () => [],
      create: opts.appError ? fail(opts.appError) : async () => ({ sid: 'AP1' }),
    }),
    intelligence: {
      v2: {
        services: Object.assign(() => ({ update: async () => ({ sid: 'GA1', languageCode: 'en-AU' }) }), {
          list: opts.intelligenceError ? fail(opts.intelligenceError) : async () => [],
          create: async () => ({ sid: 'GA1', languageCode: 'en-AU' }),
        }),
      },
    },
    incomingPhoneNumbers: Object.assign(() => ({ update: async () => ({}) }), { list: async () => [{ sid: 'PN1', phoneNumber: '+61480000001' }] }),
  };
  return client as unknown as Parameters<typeof runTwilioSetup>[0];
}

describe('runTwilioSetup', () => {
  it('sets everything up', async () => {
    const r = await runTwilioSetup(fakeClient({}), 'https://dialer.example.com/');
    expect(r).toMatchObject({ twimlAppSid: 'AP1', intelligenceServiceSid: 'GA1', transcriptsSkipped: null, numbersUpdated: ['+61480000001'] });
  });

  it('names the failing step and passes on Twilio’s reason', async () => {
    const err = Object.assign(new Error('Authenticate'), { code: 20003, status: 401 });
    await expect(runTwilioSetup(fakeClient({ appError: err }), 'https://x')).rejects.toThrow(
      'Creating the calling app (TwiML App) failed. Twilio error 20003 (401): Authenticate',
    );
  });

  it('still sets up calling when Twilio refuses the transcript service', async () => {
    const err = Object.assign(new Error('Forbidden'), { code: 20403, status: 403 });
    const r = await runTwilioSetup(fakeClient({ intelligenceError: err }), 'https://x');
    expect(r.twimlAppSid).toBe('AP1');
    expect(r.intelligenceServiceSid).toBeNull();
    expect(r.transcriptsSkipped).toBe('Twilio error 20403 (403): Forbidden');
  });
});
