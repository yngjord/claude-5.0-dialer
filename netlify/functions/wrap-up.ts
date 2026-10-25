import type { Config } from '@netlify/functions';
import { CALLBACK, CONNECTED_PICKUP_STATUS, isDisposition, isPickupStatus, LEAD_DISPOSITIONS } from '../../shared/constants';
import { buildLeadFields, recordingLink, todayInSydney, validateLead } from '../../shared/leads';
import { contactOutcome } from '../../shared/outcomes';
import type { WrapUpRequest, WrapUpResponse } from '../../shared/types';
import { createRecord } from './_lib/airtable';
import { requireSignedIn } from './_lib/auth';
import { addToBlocklist } from './_lib/blocklist';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

const REFUSALS: Record<string, [number, string]> = {
  user: [403, 'The dialer is only available to the Maronly team.'],
  not_found: [404, "This call wasn't logged. Check your connection and try the next one."],
  forbidden: [403, 'This is not your call.'],
};

/**
 * POST /api/wrap-up: the post-call form. One database round trip (dialer_save_wrap_up) saves pickup status (as
 * corrected by the rep), disposition and notes, and moves the contact on (or, for Callback, holds it for this rep
 * until the callback time). For the two "Interested" dispositions it
 * then creates the lead in the CRM (Airtable), with a permanent link to the call recording (/r/{callId}.mp3), so
 * only those saves wait on Airtable.
 *
 * Safe to submit again: the contact's attempt count only goes up once, and a lead is only created once. If
 * Airtable fails, the call is still saved and `leadError` is returned so the rep can retry.
 */
export default handler(async (req, context) => {
  const [user, body] = await Promise.all([requireSignedIn(req), readJson<WrapUpRequest>(req)]);
  if (!isPickupStatus(body.pickupStatus)) throw new HttpError(400, 'Choose a pickup status.');
  if (!isDisposition(body.disposition)) throw new HttpError(400, 'Choose a disposition.');

  // Callback: when to call back (any time from now on).
  let callbackAt: string | null = null;
  if (body.disposition === CALLBACK) {
    const at = body.callbackAt ? new Date(body.callbackAt) : null;
    if (!at || Number.isNaN(at.getTime())) throw new HttpError(400, 'Choose when to call back.');
    if (at.getTime() < Date.now() - 5 * 60_000) throw new HttpError(400, 'The callback time is in the past.');
    callbackAt = at.toISOString();
  }

  const needsLead = LEAD_DISPOSITIONS.includes(body.disposition);
  if (needsLead) {
    if (!body.lead) throw new HttpError(400, 'Fill in the lead details.');
    const problems = validateLead(body.disposition, body.lead);
    if (problems.length) throw new HttpError(400, problems.join(' '));
  }

  const saved = must(
    await db().rpc('dialer_save_wrap_up', {
      p_call_id: body.callId,
      p_user_id: user.id,
      p_pickup: body.pickupStatus,
      p_disposition: body.disposition,
      p_notes: body.notes ?? '',
      p_contact_status: contactOutcome(body.disposition),
      p_lead_name: needsLead ? (body.lead?.fullName ?? null) : null,
      p_lead_email: needsLead ? (body.lead?.email ?? null) : null,
      p_callback_at: callbackAt,
    }),
  ) as {
    error?: string;
    contact_id: string | null;
    airtable_lead_id: string | null;
    campaign_name: string | null;
    airtable_client_id: string | null;
    linkedin: string | null;
    website: string | null;
  };
  if (saved.error) {
    const [status, message] = REFUSALS[saved.error] ?? [400, 'Could not save this call.'];
    throw new HttpError(status, message);
  }

  // Human pickups go on the client's Airtable blocklist, in the background so the rep isn't kept waiting (the sweep
  // retries if Airtable fails).
  if (body.pickupStatus === CONNECTED_PICKUP_STATUS) {
    context.waitUntil(addToBlocklist(body.callId).catch((err) => console.error('Blocklist failed for call', body.callId, err)));
  }

  let leadId = saved.airtable_lead_id;
  let leadError: string | null = null;
  if (needsLead && body.lead && !leadId) {
    if (!saved.airtable_client_id) throw new HttpError(400, "This call's campaign no longer exists, so a lead can't be created.");
    try {
      leadId = await createRecord(
        'Leads',
        buildLeadFields(body.disposition, body.lead, {
          airtableClientId: saved.airtable_client_id,
          campaignName: saved.campaign_name ?? '',
          linkedin: saved.linkedin,
          website: saved.website,
          todaySydney: todayInSydney(),
          attributedTo: user.email,
          // The site the rep is on (dialer.maronly.com.au in production), so preview leads link to the preview.
          recordingLink: recordingLink(new URL(req.url).origin, body.callId),
        }),
      );
      await Promise.all([
        db().from('dialer_calls').update({ airtable_lead_id: leadId, lead_sync_error: null }).eq('id', body.callId).then(must),
        saved.contact_id ? db().from('dialer_contacts').update({ airtable_lead_id: leadId }).eq('id', saved.contact_id).then(must) : null,
      ]);
    } catch (err) {
      leadError = err instanceof Error ? err.message : 'Could not create the lead in the CRM.';
      console.error('Lead creation failed for call', body.callId, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', body.callId));
    }
  }

  return json({ ok: true, leadId, leadError } satisfies WrapUpResponse);
});

export const config: Config = { path: '/api/wrap-up', method: 'POST' };
