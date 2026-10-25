import type { Config } from '@netlify/functions';
import { APPOINTMENT_SET } from '../../shared/constants';
import { buildLeadFields, todayInSydney, validateManualBooking } from '../../shared/leads';
import type { NewBookingRequest, NewBookingResponse } from '../../shared/types';
import { createRecord } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { assignedClientIds } from './_lib/clients';
import { handler, HttpError, json, readJson } from './_lib/http';

/**
 * POST /api/leads: adds a booking by hand (the Leads tab's "Add new lead", replacing the Airtable "New Booking" form
 * while calls move over from JustCall). Always a Cold Call lead at the Booking stage, attributed to the rep.
 * Team members can only add leads for the clients they're assigned to.
 */
export default handler(async (req) => {
  const [me, body] = await Promise.all([requireDialerUser(req), readJson<NewBookingRequest>(req)]);
  const problems = validateManualBooking(body);
  if (problems.length) throw new HttpError(400, problems.join(' '));
  const assigned = await assignedClientIds(me);
  if (assigned && !assigned.has(body.airtableClientId)) throw new HttpError(403, "You're not assigned to this client.");

  const leadId = await createRecord(
    'Leads',
    buildLeadFields(APPOINTMENT_SET, body.lead, {
      airtableClientId: body.airtableClientId,
      campaignName: body.campaignName.trim(),
      linkedin: body.linkedin,
      website: null,
      todaySydney: todayInSydney(),
      attributedTo: me.email,
    }),
  );
  return json({ leadId } satisfies NewBookingResponse);
});

export const config: Config = { path: '/api/leads', method: 'POST' };
