import { BOOKING_TABLE, buildBookingFields, LEAD_FIELDS, type LeadInput } from '../../../shared/leads';
import { createRecord, getRecord } from './airtable';

/**
 * Creates the Booking Request for an Appointment Set lead, linked to it in the same call (so Airtable's "New booking
 * request" automation sees the lead). `leadJustCreated` false means this is a retry of the same wrap-up: the lead was
 * made earlier, so it only gets a booking request if it doesn't have one yet, and the retry can't add a second.
 * Returns the booking request id, or null when the lead already had one.
 */
export async function createLeadBooking(leadId: string, lead: LeadInput, leadJustCreated: boolean): Promise<string | null> {
  if (!leadJustCreated) {
    const existing = await getRecord<Record<string, string[]>>('Leads', leadId, { byFieldId: true });
    if (existing.fields[LEAD_FIELDS.bookings]?.length) return null;
  }
  return createRecord(BOOKING_TABLE, buildBookingFields(leadId, lead));
}
