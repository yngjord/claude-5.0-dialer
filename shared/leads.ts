import { APPOINTMENT_SET, type Disposition } from './constants';

/** The extra fields the wrap-up form shows for the two "Interested" dispositions. */
export interface LeadInput {
  fullName: string;
  email: string;
  phone: string;
  notes: string;
  /** YYYY-MM-DD. Appointment Set only (required). */
  bookedFor?: string | null;
  /** Free text, e.g. "2:30pm AEDT". Appointment Set only (required). */
  timeBookedFor?: string | null;
}

/** Fields written to Airtable 'Leads'. Names must match the base exactly (typecast is off). */
export interface LeadFields {
  'Prospect Full Name': string;
  'Prospect Email': string;
  'Phone Number': string;
  Client: string[];
  Channel: 'Cold Call';
  'Campaign Name': string;
  'Notes (Maronly)': string;
  'Linkedin Profile': string;
  Website: string;
  'Record Status': 'Open';
  Stage: 'Nurture' | 'Booking';
  'Next follow up': string;
  'Booked For': string;
  'Time Booked for (plain text)': string;
  'Date Booked': string;
  'Call Recording Link': string;
  [ATTRIBUTED_TO_FIELD]: string;
}

/**
 * Leads → "Attributed to - new dialer" (text): the email of the rep who created the lead. Written by field id, so
 * renaming the field in Airtable doesn't break creating leads.
 */
export const ATTRIBUTED_TO_FIELD = 'fldKG3QEhKosSdvxc';
/** Its current name, for Airtable formulas (which can't use field ids). Update this if the field is renamed. */
export const ATTRIBUTED_TO_FIELD_NAME = 'Attributed to - new dialer';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns a list of problems with the form; empty when it can be sent. */
export function validateLead(disposition: Disposition, lead: LeadInput): string[] {
  const errors: string[] = [];
  if (!lead.fullName.trim()) errors.push('Prospect full name is required.');
  if (lead.email.trim() && !EMAIL.test(lead.email.trim())) errors.push('Email address looks wrong.');
  if (disposition === APPOINTMENT_SET) {
    if (!lead.bookedFor || !DATE.test(lead.bookedFor)) errors.push('Booked for date is required.');
    if (!lead.timeBookedFor?.trim()) errors.push('Time booked for is required.');
  }
  return errors;
}

/**
 * Builds the Airtable Leads record for an "Interested" wrap-up. Leads are only ever created, never updated.
 * Empty values are left out so Airtable doesn't get blank strings for URL/date fields.
 */
export function buildLeadFields(
  disposition: Disposition,
  lead: LeadInput,
  ctx: { airtableClientId: string; campaignName: string; linkedin: string | null; website: string | null; todaySydney: string; attributedTo: string; recordingLink: string },
): Partial<LeadFields> {
  const fields: Partial<LeadFields> = {
    'Prospect Full Name': lead.fullName.trim(),
    'Prospect Email': lead.email.trim(),
    'Phone Number': lead.phone.trim(),
    Client: [ctx.airtableClientId],
    Channel: 'Cold Call',
    'Campaign Name': ctx.campaignName,
    'Notes (Maronly)': lead.notes.trim(),
    'Linkedin Profile': ctx.linkedin?.trim() ?? '',
    Website: ctx.website?.trim() ?? '',
    'Record Status': 'Open',
    'Call Recording Link': ctx.recordingLink,
    [ATTRIBUTED_TO_FIELD]: ctx.attributedTo.trim(),
  };

  if (disposition === APPOINTMENT_SET) {
    fields.Stage = 'Booking';
    fields['Booked For'] = lead.bookedFor ?? '';
    fields['Time Booked for (plain text)'] = lead.timeBookedFor?.trim() ?? '';
    fields['Date Booked'] = ctx.todaySydney;
  } else {
    // Needs Follow-Up leads are always due for follow-up from today.
    fields.Stage = 'Nurture';
    fields['Next follow up'] = ctx.todaySydney;
  }

  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '' && v != null)),
  ) as Partial<LeadFields>;
}

/** The permanent recording link for a call (served by netlify/functions/recording-link.ts). */
export function recordingLink(baseUrl: string, callId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/r/${callId}.mp3`;
}

/** Today's date in Sydney as YYYY-MM-DD. */
export function todayInSydney(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
