import type { Config } from '@netlify/functions';
import { isDisposition, isPickupStatus, LEAD_DISPOSITIONS } from '../../shared/constants';
import { buildLeadFields, todayInSydney, validateLead } from '../../shared/leads';
import { contactOutcome } from '../../shared/outcomes';
import type { CallRow, Campaign, Contact, WrapUpRequest, WrapUpResponse } from '../../shared/types';
import { createRecord } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

/**
 * POST /api/wrap-up: the post-call form. Saves pickup status (as corrected by the rep), disposition and notes,
 * moves the contact on in the queue, and for the two "Interested" dispositions creates a Lead in Airtable.
 *
 * Safe to submit again: the contact's attempt count only goes up once, and a Lead is only created once. If
 * Airtable fails, the call is still saved and `leadError` is returned so the rep can retry.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const body = await readJson<WrapUpRequest>(req);
  if (!isPickupStatus(body.pickupStatus)) throw new HttpError(400, 'Choose a pickup status.');
  if (!isDisposition(body.disposition)) throw new HttpError(400, 'Choose a disposition.');

  const call = must(await db().from('dialer_calls').select('*').eq('id', body.callId).maybeSingle()) as CallRow | null;
  if (!call) throw new HttpError(404, "This call wasn't logged. Check your connection and try the next one.");
  if (call.user_id !== me.userId && me.role !== 'admin') throw new HttpError(403, 'This is not your call.');

  const needsLead = LEAD_DISPOSITIONS.includes(body.disposition);
  if (needsLead) {
    if (!body.lead) throw new HttpError(400, 'Fill in the lead details.');
    const problems = validateLead(body.disposition, body.lead);
    if (problems.length) throw new HttpError(400, problems.join(' '));
  }

  const firstWrapUp = !call.wrapped_up_at;
  const pickupChanged = body.pickupStatus !== call.pickup_status;
  must(
    await db()
      .from('dialer_calls')
      .update({
        disposition: body.disposition,
        notes: body.notes?.trim() || null,
        wrapped_up_at: call.wrapped_up_at ?? new Date().toISOString(),
        ...(pickupChanged ? { pickup_status: body.pickupStatus, pickup_source: 'agent' } : {}),
      })
      .eq('id', call.id),
  );

  const contact = call.contact_id ? (must(await db().from('dialer_contacts').select('*').eq('id', call.contact_id).maybeSingle()) as Contact | null) : null;
  const campaign = call.campaign_id ? (must(await db().from('dialer_campaigns').select('*').eq('id', call.campaign_id).maybeSingle()) as Campaign | null) : null;

  if (contact && campaign) {
    const attempts = firstWrapUp ? contact.attempts + 1 : contact.attempts;
    must(
      await db()
        .from('dialer_contacts')
        .update({
          attempts,
          last_called_at: call.started_at,
          last_disposition: body.disposition,
          status: contactOutcome(body.disposition),
          next_attempt_at: null,
          locked_by: null,
          locked_at: null,
          // Keep corrections the rep made in the lead form.
          ...(needsLead && body.lead ? { full_name: body.lead.fullName.trim() || contact.full_name, email: body.lead.email.trim() || contact.email } : {}),
        })
        .eq('id', contact.id),
    );
  }

  // Do Not Call applies to the number everywhere, not just this campaign.
  if (body.disposition === 'Do Not Call' && call.phone_e164) {
    must(await db().from('dialer_contacts').update({ status: 'do_not_call', locked_by: null, locked_at: null }).eq('phone_e164', call.phone_e164));
  }

  let leadId = call.airtable_lead_id;
  let leadError: string | null = null;
  if (needsLead && body.lead && !leadId) {
    if (!campaign) throw new HttpError(400, "This call's campaign no longer exists, so a Lead can't be created.");
    try {
      leadId = await createRecord(
        'Leads',
        buildLeadFields(body.disposition, body.lead, {
          airtableClientId: campaign.airtable_client_id,
          campaignName: campaign.name,
          linkedin: call.linkedin,
          website: call.website,
          todaySydney: todayInSydney(),
        }),
      );
      must(await db().from('dialer_calls').update({ airtable_lead_id: leadId, lead_sync_error: null }).eq('id', call.id));
      if (contact) must(await db().from('dialer_contacts').update({ airtable_lead_id: leadId }).eq('id', contact.id));
    } catch (err) {
      leadError = err instanceof Error ? err.message : 'Could not create the Lead in Airtable.';
      console.error('Lead creation failed for call', call.id, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', call.id));
    }
  }

  return json({ ok: true, leadId, leadError } satisfies WrapUpResponse);
});

export const config: Config = { path: '/api/wrap-up', method: 'POST' };
