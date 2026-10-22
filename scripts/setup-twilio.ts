/**
 * One-off Twilio setup, safe to re-run. Creates (or updates) everything the dialer needs on the Twilio account:
 *   1. a TwiML App whose Voice URL is /api/twilio/voice (browser calls go through it)
 *   2. a Voice Intelligence service for transcripts, posting to /api/twilio/transcript
 *   3. voicemail + SMS webhooks on every number on the account
 * Then prints the SIDs to put in Netlify's environment variables.
 *
 *   TWILIO_ACCOUNT_SID=AC… TWILIO_API_KEY_SID=SK… TWILIO_API_KEY_SECRET=… PUBLIC_BASE_URL=https://dialer.maronly.com.au \
 *     npm run setup:twilio
 */
import twilio from 'twilio';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};

const base = need('PUBLIC_BASE_URL').replace(/\/$/, '');
const client = twilio(need('TWILIO_API_KEY_SID'), need('TWILIO_API_KEY_SECRET'), { accountSid: need('TWILIO_ACCOUNT_SID') });
const APP_NAME = 'Maronly Dialer';
const SERVICE_NAME = 'maronly-dialer';

async function main() {
  const voiceUrl = `${base}/api/twilio/voice`;
  const existingApp = (await client.applications.list({ friendlyName: APP_NAME, limit: 1 }))[0];
  const app = existingApp
    ? await client.applications(existingApp.sid).update({ voiceUrl, voiceMethod: 'POST' })
    : await client.applications.create({ friendlyName: APP_NAME, voiceUrl, voiceMethod: 'POST' });
  console.log(`TwiML App ${existingApp ? 'updated' : 'created'}: ${app.sid} → ${voiceUrl}`);

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
      console.warn('en-AU transcription not available on this account, falling back to en-US:', (err as Error).message);
      service = await client.intelligence.v2.services.create({ uniqueName: SERVICE_NAME, languageCode: 'en-US', ...settings });
    }
  }
  console.log(`Voice Intelligence service ${existingService ? 'updated' : 'created'}: ${service.sid} (${service.languageCode}) → ${webhookUrl}`);

  const numbers = await client.incomingPhoneNumbers.list({ limit: 200 });
  for (const n of numbers) {
    await client.incomingPhoneNumbers(n.sid).update({
      voiceUrl: `${base}/api/twilio/inbound-voice`,
      voiceMethod: 'POST',
      smsUrl: `${base}/api/twilio/inbound-sms`,
      smsMethod: 'POST',
    });
    console.log(`Number ${n.phoneNumber}: voicemail + SMS webhooks set`);
  }
  if (!numbers.length) console.log('No numbers on the account yet. Buy AU mobile numbers, then re-run this (or use Sync from Twilio in the app).');

  console.log('\nAdd these to the Netlify site\'s environment variables:');
  console.log(`  TWILIO_TWIML_APP_SID=${app.sid}`);
  console.log(`  TWILIO_INTELLIGENCE_SERVICE_SID=${service.sid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
