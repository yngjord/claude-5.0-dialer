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
  intelligenceServiceSid: string;
  transcriptLanguage: string;
  numbersUpdated: string[];
  log: string[];
}

export async function runTwilioSetup(client: ReturnType<typeof twilio>, baseUrl: string): Promise<TwilioSetupResult> {
  const base = baseUrl.replace(/\/$/, '');
  const log: string[] = [];

  const voiceUrl = `${base}/api/twilio/voice`;
  const existingApp = (await client.applications.list({ friendlyName: APP_NAME, limit: 1 }))[0];
  const app = existingApp
    ? await client.applications(existingApp.sid).update({ voiceUrl, voiceMethod: 'POST' })
    : await client.applications.create({ friendlyName: APP_NAME, voiceUrl, voiceMethod: 'POST' });
  log.push(`TwiML App ${existingApp ? 'updated' : 'created'}: ${app.sid} → ${voiceUrl}`);

  const webhookUrl = `${base}/api/twilio/transcript`;
  const services = await client.intelligence.v2.services.list({ limit: 100 });
  const existingService = services.find((s) => s.uniqueName === SERVICE_NAME);
  const settings = { friendlyName: APP_NAME, webhookUrl, webhookHttpMethod: 'POST' as const, autoTranscribe: false, dataLogging: false };
  let service;
  if (existingService) service = await client.intelligence.v2.services(existingService.sid).update(settings);
  else {
    try {
      service = await client.intelligence.v2.services.create({ uniqueName: SERVICE_NAME, languageCode: 'en-AU', ...settings });
    } catch (err) {
      log.push(`Australian English transcription isn't available on this account (${(err as Error).message}); using US English.`);
      service = await client.intelligence.v2.services.create({ uniqueName: SERVICE_NAME, languageCode: 'en-US', ...settings });
    }
  }
  log.push(`Voice Intelligence service ${existingService ? 'updated' : 'created'}: ${service.sid} (${service.languageCode}) → ${webhookUrl}`);

  const numbers = await client.incomingPhoneNumbers.list({ limit: 200 });
  for (const n of numbers) {
    await client.incomingPhoneNumbers(n.sid).update({
      voiceUrl: `${base}/api/twilio/inbound-voice`,
      voiceMethod: 'POST',
      smsUrl: `${base}/api/twilio/inbound-sms`,
      smsMethod: 'POST',
    });
    log.push(`Number ${n.phoneNumber}: voicemail + SMS webhooks set`);
  }
  if (!numbers.length) log.push('No numbers on the account yet. Ones bought with Buy number are set up automatically.');

  return {
    twimlAppSid: app.sid,
    intelligenceServiceSid: service.sid,
    transcriptLanguage: service.languageCode,
    numbersUpdated: numbers.map((n) => n.phoneNumber),
    log,
  };
}
