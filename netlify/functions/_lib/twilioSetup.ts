import type twilio from 'twilio';

// One-off Twilio setup, safe to re-run. Creates (or updates) what the dialer needs on the Twilio account:
//   1. a TwiML App whose Voice URL is <base>/api/twilio/voice (calls from the browser go through it)
//   2. a Voice Intelligence service for transcripts, posting to <base>/api/twilio/transcript
//   3. voicemail + SMS webhooks on every number already on the account
// Used by the admin "Finish Twilio setup" button and by scripts/setup-twilio.ts.

const APP_NAME = 'Maronly Dialer';
const SERVICE_NAME = 'maronly-dialer';

export interface TwilioSetupResult {
  twimlAppSid: string;
  /** Null when Twilio wouldn't create the transcript service; `transcriptsSkipped` says why. Calling still works. */
  intelligenceServiceSid: string | null;
  transcriptLanguage: string | null;
  transcriptsSkipped: string | null;
  numbersUpdated: string[];
  log: string[];
}

/** Twilio's own error, e.g. "Twilio error 20003 (401): Authenticate". */
export function twilioErrorMessage(err: unknown): string {
  const e = err as { code?: number; status?: number; message?: string; moreInfo?: string };
  const parts = [e.code ? `Twilio error ${e.code}` : 'Twilio error', e.status ? `(${e.status})` : ''].filter(Boolean).join(' ');
  return `${parts}: ${e.message ?? String(err)}${e.moreInfo ? ` See ${e.moreInfo}` : ''}`;
}

/** A setup step that failed; the message names the step and carries Twilio's error. */
export class TwilioSetupError extends Error {}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Twilio setup: ${name} failed`, err);
    throw new TwilioSetupError(`${name} failed. ${twilioErrorMessage(err)}`);
  }
}

export async function runTwilioSetup(client: ReturnType<typeof twilio>, baseUrl: string): Promise<TwilioSetupResult> {
  const base = baseUrl.replace(/\/$/, '');
  const log: string[] = [];

  // 1. Calling (required).
  const voiceUrl = `${base}/api/twilio/voice`;
  const existingApp = (await step('Looking up the calling app (TwiML App)', () => client.applications.list({ friendlyName: APP_NAME, limit: 1 })))[0];
  const app = await step(`${existingApp ? 'Updating' : 'Creating'} the calling app (TwiML App)`, () =>
    existingApp
      ? client.applications(existingApp.sid).update({ voiceUrl, voiceMethod: 'POST' })
      : client.applications.create({ friendlyName: APP_NAME, voiceUrl, voiceMethod: 'POST' }),
  );
  log.push(`TwiML App ${existingApp ? 'updated' : 'created'}: ${app.sid} → ${voiceUrl}`);

  // 2. Transcripts (optional: calling works without them).
  const webhookUrl = `${base}/api/twilio/transcript`;
  const settings = { friendlyName: APP_NAME, webhookUrl, webhookHttpMethod: 'POST' as const, autoTranscribe: false, dataLogging: false };
  let service: { sid: string; languageCode: string } | null = null;
  let transcriptsSkipped: string | null = null;
  try {
    const existingService = (await client.intelligence.v2.services.list({ limit: 100 })).find((s) => s.uniqueName === SERVICE_NAME);
    if (existingService) service = await client.intelligence.v2.services(existingService.sid).update(settings);
    else {
      try {
        service = await client.intelligence.v2.services.create({ uniqueName: SERVICE_NAME, languageCode: 'en-AU', ...settings });
      } catch (err) {
        log.push(`Australian English transcription wasn't accepted (${twilioErrorMessage(err)}); trying US English.`);
        service = await client.intelligence.v2.services.create({ uniqueName: SERVICE_NAME, languageCode: 'en-US', ...settings });
      }
    }
    log.push(`Voice Intelligence service ${existingService ? 'updated' : 'created'}: ${service.sid} (${service.languageCode}) → ${webhookUrl}`);
  } catch (err) {
    console.error('Twilio setup: transcript service failed', err);
    transcriptsSkipped = twilioErrorMessage(err);
    log.push(`Transcripts skipped: ${transcriptsSkipped}`);
  }

  // 3. Voicemail + texts on numbers already on the account.
  const numbers = await step('Listing your Twilio numbers', () => client.incomingPhoneNumbers.list({ limit: 200 }));
  for (const n of numbers) {
    await step(`Setting voicemail and text webhooks on ${n.phoneNumber}`, () =>
      client.incomingPhoneNumbers(n.sid).update({
        voiceUrl: `${base}/api/twilio/inbound-voice`,
        voiceMethod: 'POST',
        smsUrl: `${base}/api/twilio/inbound-sms`,
        smsMethod: 'POST',
      }),
    );
    log.push(`Number ${n.phoneNumber}: voicemail + SMS webhooks set`);
  }
  if (!numbers.length) log.push('No numbers on the account yet. Ones bought with Buy number are set up automatically.');

  return {
    twimlAppSid: app.sid,
    intelligenceServiceSid: service?.sid ?? null,
    transcriptLanguage: service?.languageCode ?? null,
    transcriptsSkipped,
    numbersUpdated: numbers.map((n) => n.phoneNumber),
    log,
  };
}
