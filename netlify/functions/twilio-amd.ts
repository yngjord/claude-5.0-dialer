import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { verifyTwilioWebhook } from './_lib/twilio';

/** POST /api/twilio/amd?callId=…: answering machine detection result (human / machine_* / fax / unknown). */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const callId = new URL(req.url).searchParams.get('callId');
  if (callId && p.AnsweredBy) must(await db().from('dialer_calls').update({ answered_by: p.AnsweredBy }).eq('id', callId));
  return json({ ok: true });
});

export const config: Config = { path: '/api/twilio/amd', method: 'POST' };
