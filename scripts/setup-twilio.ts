/**
 * One-off Twilio setup from the command line (admins can also use "Finish Twilio setup" on the Phone numbers page,
 * which does the same with the keys already in Netlify). Safe to re-run. Prints the SIDs to add to Netlify.
 *
 *   TWILIO_ACCOUNT_SID=AC… TWILIO_API_KEY_SID=SK… TWILIO_API_KEY_SECRET=… PUBLIC_BASE_URL=https://dialer.maronly.com.au \
 *     npm run setup:twilio
 */
import twilio from 'twilio';
import { runTwilioSetup } from '../netlify/functions/_lib/twilioSetup';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};

async function main() {
  const client = twilio(need('TWILIO_API_KEY_SID'), need('TWILIO_API_KEY_SECRET'), { accountSid: need('TWILIO_ACCOUNT_SID') });
  const result = await runTwilioSetup(client, need('PUBLIC_BASE_URL'));
  result.log.forEach((line) => console.log(line));
  console.log("\nAdd these to the Netlify site's environment variables, then redeploy:");
  console.log(`  TWILIO_TWIML_APP_SID=${result.twimlAppSid}`);
  console.log(`  TWILIO_INTELLIGENCE_SERVICE_SID=${result.intelligenceServiceSid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
