import type { Config } from '@netlify/functions';
import { createHash, timingSafeEqual } from 'node:crypto';
import { daysSince, linkedinPattern, parseLastDialedRequest, type LastDialedResponse } from '../../shared/lastDialed';
import { db, must } from './_lib/db';
import { env, handler, HttpError, json } from './_lib/http';

/** Constant-time check of the x-api-key header. Shares the key Clay already uses for /api/inbound/lead. */
function authorised(req: Request): boolean {
  if (!process.env.INBOUND_LEADS_API_KEY?.trim()) throw new HttpError(503, 'Not set up yet: INBOUND_LEADS_API_KEY is missing in Netlify.');
  const given = createHash('sha256')
    .update(req.headers.get('x-api-key') ?? '')
    .digest();
  const expected = createHash('sha256').update(env('INBOUND_LEADS_API_KEY')).digest();
  return timingSafeEqual(given, expected) && !!req.headers.get('x-api-key');
}

type CallRow = {
  id: string;
  started_at: string;
  disposition: string | null;
  campaign_name: string | null;
  phone_e164: string | null;
};

/**
 * POST /api/lookup/last-dialed (from Clay's HTTP API column, header x-api-key) { client, phone?, linkedin? }:
 * when this person was last dialled for this client, by phone number or LinkedIn profile, across the dialer and the
 * imported JustCall history. Never found is a normal answer (found: false), so Clay rows don't show as errors.
 */
export default handler(async (req) => {
  if (!authorised(req)) throw new HttpError(401, 'Missing or wrong x-api-key.');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'Send a JSON body.');
  }
  const parsed = parseLastDialedRequest(body);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const { lookup } = parsed;

  // Calls store the client's name; resolve whatever was sent to the name the dialer uses.
  const campaign = must(
    await (lookup.clientIsAirtableId
      ? db().from('dialer_campaigns').select('client_name').eq('airtable_client_id', lookup.client).limit(1)
      : db()
          .from('dialer_campaigns')
          .select('client_name')
          .ilike('client_name', lookup.client.replace(/[%_\\]/g, '\\$&'))
          .limit(1)),
  ) as { client_name: string }[];
  if (!campaign.length)
    throw new HttpError(
      404,
      `No client "${lookup.client}" in the dialer. Use the client name as it shows on the dialer's campaigns, or its Airtable client record id.`,
    );
  const client = campaign[0].client_name;

  const matches: string[] = [];
  if (lookup.phone) matches.push(`phone_e164.eq.${lookup.phone}`);
  if (lookup.linkedin) matches.push(`linkedin.imatch.${JSON.stringify(linkedinPattern(lookup.linkedin))}`);
  const { data, count, error } = await db()
    .from('dialer_calls')
    .select('id, started_at, disposition, campaign_name, phone_e164', {
      count: 'exact',
    })
    .eq('client_name', client)
    .eq('direction', 'outbound')
    .or(matches.join(','))
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const last = (data as CallRow[])[0];

  const out: LastDialedResponse = {
    found: !!last,
    client,
    phone: lookup.phone,
    linkedin_handle: lookup.linkedin,
    matched_by: last ? (lookup.phone && last.phone_e164 === lookup.phone ? 'phone' : 'linkedin') : null,
    last_dialed_at: last?.started_at ?? null,
    days_since_last_dial: last ? daysSince(last.started_at) : null,
    last_call_id: last?.id ?? null,
    last_disposition: last?.disposition ?? null,
    last_campaign: last?.campaign_name ?? null,
    times_dialed: count ?? 0,
  };
  return json(out);
});

export const config: Config = {
  path: '/api/lookup/last-dialed',
  method: 'POST',
};
