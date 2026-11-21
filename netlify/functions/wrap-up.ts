import type { Config } from '@netlify/functions';
import { APPOINTMENT_SET, CALLBACK, CONNECTED_PICKUP_STATUS, isDisposition, isPickupStatus, LEAD_DISPOSITIONS, REFERRAL } from '../../shared/constants';
import { sendsInvites, validateInvite, type ClientCalendar } from '../../shared/calendar';
import { buildLeadFields, buildSubleadFields, recordingLink, todayInSydney, validateLead, validateReferral } from '../../shared/leads';
import { contactOutcome } from '../../shared/outcomes';
import type { WrapUpRequest, WrapUpResponse } from '../../shared/types';
import { createRecord } from './_lib/airtable';
import { requireSignedIn } from './_lib/auth';
import { addToBlocklist, removeFromBlocklist } from './_lib/blocklist';
import { createLeadBooking } from './_lib/booking';
import { db, must } from './_lib/db';
import { calendarAccessToken, createInvite, inviteEventId } from './_lib/google';
import { syncLeadTranscript } from './_lib/leadTranscript';
import { handler, HttpError, json, readJson } from './_lib/http';
import { transcribeSkippedHumanPickup } from './_lib/media';

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
 * only those saves wait on Airtable. Appointment Set then also creates a Booking Request linked to that lead (date,
 * time and notes), which is what triggers the booking automation in Airtable. Referral also creates a sublead (the
 * person they referred us to) linked to that lead through Parent lead. If the client has Google Calendar
 * invites switched on, it then sends the invite from the host's calendar (one per call, so retries don't repeat it).
 *
 * Safe to submit again (the dialer's "Edit last call" does): the contact's attempt count only goes up once, and a
 * lead is only created once. If Airtable fails, the call is still saved and `leadError` is returned so the rep can
 * retry.
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

  let needsLead = LEAD_DISPOSITIONS.includes(body.disposition);
  // Referral: the referred person's details make the sublead. Checked even when the call's lead already exists, as
  // "Edit last call" can turn a follow-up into a referral.
  const referral = body.disposition === REFERRAL && body.referral ? body.referral : null;
  if (body.disposition === REFERRAL && (body.lead || referral)) {
    const problems = validateReferral(referral);
    if (problems.length) throw new HttpError(400, problems.join(' '));
  }
  // No lead details sent: a call that already made its lead (correcting it from the dialer) or a click-to-call
  // call (no campaign, so no client to make one for; the CRM it came from has the lead).
  if (needsLead && !body.lead) {
    const existing = must(await db().from('dialer_calls').select('airtable_lead_id, campaign_id').eq('id', body.callId).maybeSingle()) as {
      airtable_lead_id: string | null;
      campaign_id: string | null;
    } | null;
    if (existing?.airtable_lead_id || (existing && !existing.campaign_id)) needsLead = false;
  }
  if (needsLead) {
    if (!body.lead) throw new HttpError(400, 'Fill in the lead details.');
    const problems = validateLead(body.disposition, body.lead);
    if (problems.length) throw new HttpError(400, problems.join(' '));
  }
  const sendInvite = needsLead && body.disposition === APPOINTMENT_SET && !!body.invite;
  if (sendInvite) {
    const problems = validateInvite(body.invite!);
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
    // Twilio may have guessed an answering machine and skipped the transcript: the rep says it was a person.
    context.waitUntil(transcribeSkippedHumanPickup(body.callId).catch((err) => console.error('Transcript for corrected pickup failed', body.callId, err)));
  } else {
    // Corrected away from Human Pickup (e.g. "Edit last call"): take back the blocklist entry the first save made.
    context.waitUntil(removeFromBlocklist(body.callId).catch((err) => console.error('Blocklist removal failed for call', body.callId, err)));
  }

  let leadId = saved.airtable_lead_id;
  let leadError: string | null = null;
  // 1. The lead (once per call).
  let leadJustCreated = false;
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
          referredName: referral?.fullName,
        }),
      );
      await Promise.all([
        db().from('dialer_calls').update({ airtable_lead_id: leadId, lead_sync_error: null }).eq('id', body.callId).then(must),
        saved.contact_id ? db().from('dialer_contacts').update({ airtable_lead_id: leadId }).eq('id', saved.contact_id).then(must) : null,
      ]);
      leadJustCreated = true;
      // A transcript that finished before the rep saved goes on the new lead now (otherwise it's added when it lands).
      context.waitUntil(syncLeadTranscript(body.callId).catch((err) => console.error('Lead transcript sync failed', body.callId, err)));
    } catch (err) {
      leadError = err instanceof Error ? err.message : 'Could not create the lead in the CRM.';
      console.error('Lead creation failed for call', body.callId, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', body.callId));
    }
  }

  // 2. Referral: the sublead (once per call), linked to the call's lead. Also made when the lead came from an earlier
  // save of this call (a retry, or an edit that turned it into a referral).
  if (referral && leadId && !leadError) {
    try {
      const call = must(await db().from('dialer_calls').select('airtable_sublead_id, full_name, company').eq('id', body.callId).maybeSingle()) as {
        airtable_sublead_id: string | null;
        full_name: string | null;
        company: string | null;
      } | null;
      if (!call?.airtable_sublead_id) {
        if (!saved.airtable_client_id) throw new HttpError(400, "This call's campaign no longer exists, so a lead can't be created.");
        const subleadId = await createRecord(
          'Leads',
          buildSubleadFields(referral, {
            parentLeadId: leadId,
            referredBy: body.lead?.fullName?.trim() || call?.full_name || '',
            company: call?.company ?? null,
            notes: body.notes ?? '',
            airtableClientId: saved.airtable_client_id,
            campaignName: saved.campaign_name ?? '',
            website: saved.website,
            todaySydney: todayInSydney(),
            attributedTo: user.email,
          }),
        );
        must(await db().from('dialer_calls').update({ airtable_sublead_id: subleadId, lead_sync_error: null }).eq('id', body.callId));
      }
    } catch (err) {
      leadError = `The lead for the person you spoke to was created, but not the one for the person they referred you to. ${err instanceof Error ? err.message : ''}`.trim();
      console.error('Sublead creation failed for call', body.callId, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', body.callId));
    }
  }

  // 3. Appointment Set: the Booking Request, linked to that lead. On "Retry" (lead made earlier by this call) it's
  // only created if this call's lead doesn't have one yet.
  if (needsLead && body.lead && leadId && !leadError && body.disposition === APPOINTMENT_SET) {
    try {
      const bookingId = await createLeadBooking(leadId, body.lead, leadJustCreated);
      if (bookingId && !leadJustCreated) must(await db().from('dialer_calls').update({ lead_sync_error: null }).eq('id', body.callId));
    } catch (err) {
      leadError = `The lead was created, but not its booking request. ${err instanceof Error ? err.message : ''}`.trim();
      console.error('Booking request failed for call', body.callId, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', body.callId));
    }
  }

  // 4. The Google Calendar invite, from the client's connected calendar (only if the rep's form sent one).
  let inviteSent = false;
  if (sendInvite && leadId && !leadError && saved.airtable_client_id) {
    try {
      const settings = must(
        await db().from('dialer_client_calendars').select('invites_enabled, status, google_email').eq('airtable_client_id', saved.airtable_client_id).maybeSingle(),
      ) as Pick<ClientCalendar, 'invites_enabled' | 'status' | 'google_email'> | null;
      if (!sendsInvites(settings)) throw new HttpError(409, "This client's calendar invites are switched off or not connected.");
      const inv = body.invite!;
      await createInvite(await calendarAccessToken(saved.airtable_client_id), {
        id: inviteEventId(body.callId),
        summary: inv.title.trim(),
        description: inv.description.trim(),
        start: new Date(inv.startsAt),
        minutes: inv.minutes,
        timeZone: inv.timeZone,
        guests: inv.guests,
        hostEmail: settings!.google_email,
      });
      inviteSent = true;
      must(await db().from('dialer_calls').update({ lead_sync_error: null }).eq('id', body.callId));
    } catch (err) {
      leadError = `The lead and booking request were saved, but the calendar invite wasn't sent. ${err instanceof Error ? err.message : ''}`.trim();
      console.error('Calendar invite failed for call', body.callId, err);
      must(await db().from('dialer_calls').update({ lead_sync_error: leadError }).eq('id', body.callId));
    }
  }

  return json({ ok: true, leadId, leadError, inviteSent } satisfies WrapUpResponse);
});

export const config: Config = { path: '/api/wrap-up', method: 'POST' };
