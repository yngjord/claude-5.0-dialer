import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { handler, json } from './_lib/http';
import { verifyTwilioWebhook } from './_lib/twilio';

const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

/**
 * POST /api/twilio/call-status?callId=…: status events for the prospect's leg (initiated, ringing, answered,
 * completed). Pickup Status is derived from these by the calls_pickup trigger.
 */
export default handler(async (req) => {
  const p = await verifyTwilioWebhook(req);
  const callId = new URL(req.url).searchParams.get('callId');
  if (!callId) return json({ ok: true });

  const status = p.CallStatus;
  const patch: Record<string, unknown> = { twilio_status: status, twilio_child_sid: p.CallSid };
  if (status === 'in-progress') patch.answered_at = new Date().toISOString();

  if (status === 'failed' || status === 'busy') {
    // Twilio's reason for the failure, e.g. 13227 (geo permissions) or SIP 403/404. Shows in the Netlify function logs.
    console.warn(`Call ${callId} ${status}: ErrorCode=${p.ErrorCode ?? '-'} SipResponseCode=${p.SipResponseCode ?? '-'} ${p.ErrorMessage ?? ''}`.trim());
  }
  if (FINAL.includes(status)) {
    patch.ended_at = new Date().toISOString();
    patch.duration_s = Number.parseInt(p.CallDuration ?? '0', 10) || 0;
    must(await db().from('dialer_calls').update(patch).eq('id', callId));
  } else {
    // Events can arrive out of order: never let "ringing" overwrite a finished call.
    must(await db().from('dialer_calls').update(patch).eq('id', callId).or(`twilio_status.is.null,twilio_status.not.in.(${FINAL.join(',')})`));
  }
  return json({ ok: true });
});

export const config: Config = { path: '/api/twilio/call-status', method: 'POST' };
