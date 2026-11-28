import type { Config } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mergeContext, validateInboundLead, type InboundLeadRequest, type InboundLeadResponse } from '../../shared/inboundLead';
import { todayInSydney } from '../../shared/leads';
import { startLabelling } from './_lib/companyJobs';
import { db, must } from './_lib/db';
import { env, handler, HttpError, json } from './_lib/http';

/** Constant-time check of the x-api-key header against INBOUND_LEADS_API_KEY. */
function authorised(req: Request): boolean {
  if (!process.env.INBOUND_LEADS_API_KEY?.trim()) throw new HttpError(503, 'Not set up yet: INBOUND_LEADS_API_KEY is missing in Netlify.');
  const given = createHash('sha256').update(req.headers.get('x-api-key') ?? '').digest();
  const expected = createHash('sha256').update(env('INBOUND_LEADS_API_KEY')).digest();
  return timingSafeEqual(given, expected) && !!req.headers.get('x-api-key');
}

type ContactRow = { id: string; status: string; context: string | null; custom: Record<string, unknown> | null };

/**
 * POST /api/inbound/lead (from Clay's HTTP API column, header x-api-key): a warm lead a client submitted in the
 * portal, once Clay has found their mobile. Added to that client's evergreen campaign with the client's context.
 * - The same submission sent again (Clay re-runs) updates the contact instead of adding a second one.
 * - Someone already in the evergreen campaign gets the new context added and, if they'd been finished, is queued again.
 * - Refused: no evergreen campaign for the client (404), a number on Do Not Call (409), or bad data (400).
 */
export default handler(async (req, context) => {
  if (!authorised(req)) throw new HttpError(401, 'Missing or wrong x-api-key.');
  let body: Partial<InboundLeadRequest> | null = null;
  try {
    body = (await req.json()) as Partial<InboundLeadRequest>;
  } catch {
    throw new HttpError(400, 'Send a JSON body.');
  }
  const v = validateInboundLead(body);
  if (!v.ok) throw new HttpError(400, v.errors.join(' '));
  const lead = v.lead;

  const campaign = must(
    await db().from('dialer_campaigns').select('id, name').eq('airtable_client_id', lead.airtableClientId).eq('is_evergreen', true).maybeSingle(),
  ) as { id: string; name: string } | null;
  if (!campaign) throw new HttpError(404, 'This client has no evergreen campaign in the dialer yet. Create one first (Campaigns → Evergreen).');

  const dnc = must(await db().from('dialer_contacts').select('id').eq('phone_e164', lead.phone).eq('status', 'do_not_call').limit(1));
  if ((dnc as unknown[]).length) throw new HttpError(409, 'This number asked not to be called (Do Not Call), so it was not added.');

  // Already here: the same submission (a re-run), or the same person from an earlier submission.
  const existing = must(
    await db()
      .from('dialer_contacts')
      .select('id, status, context, custom')
      .eq('campaign_id', campaign.id)
      .or(`custom->>portal_submission_id.eq.${lead.submissionId.replace(/[,()]/g, '')},phone_e164.eq.${lead.phone}`)
      .limit(1),
  ) as ContactRow[];

  const details = {
    full_name: lead.fullName,
    first_name: lead.firstName,
    title: lead.title,
    company: lead.company,
    email: lead.email,
    linkedin: lead.linkedin,
    website: lead.website,
  };
  const custom = { portal_submission_id: lead.submissionId, ...(lead.submittedBy ? { submitted_by: lead.submittedBy } : {}) };

  if (existing[0]) {
    const c = existing[0];
    const sameSubmission = String(c.custom?.portal_submission_id ?? '') === lead.submissionId;
    const requeue = !sameSubmission && (c.status === 'done' || c.status === 'bad_number' || c.status === 'skipped');
    must(
      await db()
        .from('dialer_contacts')
        .update({
          // Keep what's already known when Clay leaves a field blank.
          ...Object.fromEntries(Object.entries(details).filter(([, val]) => val)),
          context: sameSubmission ? lead.context : mergeContext(c.context, lead.context, todayInSydney()),
          custom: { ...(c.custom ?? {}), ...custom },
          ...(requeue ? { status: 'new', next_attempt_at: null } : {}),
        })
        .eq('id', c.id),
    );
    return json({ status: 'updated', contact_id: c.id, campaign_id: campaign.id, campaign_name: campaign.name } satisfies InboundLeadResponse);
  }

  const inserted = must(
    await db()
      .from('dialer_contacts')
      .insert({ ...details, campaign_id: campaign.id, phone_e164: lead.phone, phone_raw: lead.phoneRaw, context: lead.context, custom, source: 'api' })
      .select('id')
      .single(),
  ) as { id: string };
  // A new company (by its website) gets labelled now rather than waiting for the next upload.
  if (lead.website) context.waitUntil(startLabelling());
  return json({ status: 'created', contact_id: inserted.id, campaign_id: campaign.id, campaign_name: campaign.name } satisfies InboundLeadResponse, 201);
});

export const config: Config = { path: '/api/inbound/lead', method: 'POST' };
