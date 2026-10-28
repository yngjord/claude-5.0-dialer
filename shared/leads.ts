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

/**
 * Airtable Leads fields, by field id so renaming a field in Airtable doesn't break reading or creating leads. The
 * comment is each field's name today. Only filter formulas (my-leads) use names, as Airtable formulas can't use ids.
 */
export const LEAD_FIELDS = {
  fullName: 'fldjhflLiM5HD7Gav', // Prospect Full Name
  email: 'fldamXigL4ZUHvVVT', // Prospect Email
  phone: 'fldhTSI4gv8SYKKTh', // Phone Number
  client: 'fldo5DcqcpAuteG8K', // Client (link to Clients)
  channel: 'fldrWTZXSaJSsALFp', // Channel
  campaignName: 'fldS1E9RFDmKwdcSQ', // Campaign Name
  notes: 'fldNX796UmD3S0YPw', // Notes (Maronly)
  linkedin: 'fldWN5F8nR4WLUlzO', // Linkedin Profile
  website: 'fld1lFc2Nf3c994V0', // Website
  recordStatus: 'fld87WbJl40UGTLiX', // Record Status
  stage: 'fldCNcQQLsHuo6pAy', // Stage
  nextFollowUp: 'fldOhKAOIgQDdaRy0', // Next Follow-up
  dateBookedFor: 'fld94vlZrBFMg8z2W', // Date Booked For
  timeBookedFor: 'fldkqUeG60gLfosxD', // Time Booked for (plain text)
  dateBookingMade: 'fldcea5C6NrjJPdHM', // Date Booking Made
  callRecordingLink: 'fldd8s4r5ZYx31Tdz', // Call Recording Link
  attributedTo: 'fldKG3QEhKosSdvxc', // Attributed to - new dialer: the email of the rep who created the lead
  recordCreated: 'fldBWnRJxBXSXIYSy', // Record Created
  transcript: 'fldJSugGAtJaRppT2', // Cold Call Transcript (long text): written once Twilio's transcript is ready
} as const;

/** A Leads record's fields, keyed by field id. */
export type LeadFields = Record<string, string | string[]>;

/** The "Attributed to" field's current name, for Airtable formulas (which can't use field ids). Update if renamed. */
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

/** A booking added by hand from the Leads tab (replaces the Airtable "New Booking" form). */
export interface ManualBookingInput {
  airtableClientId: string;
  campaignName: string;
  linkedin: string;
  lead: LeadInput;
}

/** Same rules as the Airtable form: everything but the notes is required. */
export function validateManualBooking(input: ManualBookingInput): string[] {
  const errors: string[] = [];
  if (!/^rec[A-Za-z0-9]{14}$/.test(input.airtableClientId ?? '')) errors.push('Choose a client.');
  if (!input.campaignName?.trim()) errors.push('Campaign name is required.');
  if (!input.lead?.email?.trim()) errors.push('Prospect email is required.');
  if (!input.lead?.phone?.trim()) errors.push('Phone number is required.');
  if (!input.linkedin?.trim()) errors.push('LinkedIn profile is required.');
  return [...errors, ...(input.lead ? validateLead(APPOINTMENT_SET, input.lead) : ['Fill in the lead details.'])];
}

/**
 * Builds the Airtable Leads record for an "Interested" wrap-up. Leads are only ever created, never updated.
 * Empty values are left out so Airtable doesn't get blank strings for URL/date fields.
 */
export function buildLeadFields(
  disposition: Disposition,
  lead: LeadInput,
  ctx: { airtableClientId: string; campaignName: string; linkedin: string | null; website: string | null; todaySydney: string; attributedTo: string; recordingLink?: string },
): LeadFields {
  const F = LEAD_FIELDS;
  const fields: LeadFields = {
    [F.fullName]: lead.fullName.trim(),
    [F.email]: lead.email.trim(),
    [F.phone]: lead.phone.trim(),
    [F.client]: [ctx.airtableClientId],
    [F.channel]: 'Cold Call',
    [F.campaignName]: ctx.campaignName,
    [F.notes]: lead.notes.trim(),
    [F.linkedin]: ctx.linkedin?.trim() ?? '',
    [F.website]: ctx.website?.trim() ?? '',
    [F.recordStatus]: 'Open',
    [F.callRecordingLink]: ctx.recordingLink ?? '',
    [F.attributedTo]: ctx.attributedTo.trim(),
  };

  if (disposition === APPOINTMENT_SET) {
    fields[F.stage] = 'Booking';
    fields[F.dateBookedFor] = lead.bookedFor ?? '';
    fields[F.timeBookedFor] = lead.timeBookedFor?.trim() ?? '';
    fields[F.dateBookingMade] = ctx.todaySydney;
  } else {
    // Needs Follow-Up leads are always due for follow-up from today.
    fields[F.stage] = 'Nurture';
    fields[F.nextFollowUp] = ctx.todaySydney;
  }

  return Object.fromEntries(Object.entries(fields).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '' && v != null)));
}

/** The permanent recording link for a call (served by netlify/functions/recording-link.ts). */
export function recordingLink(baseUrl: string, callId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/r/${callId}.mp3`;
}

/** A call transcript as written to Leads → Cold Call Transcript: "Name: text", a blank line between turns (as JustCall's were). */
export function leadTranscriptText(turns: { speaker: string; text: string }[] | null, fallback: string | null): string {
  if (turns?.length) return turns.map((t) => `${t.speaker}: ${t.text.trim()}`).join('\n\n');
  return (fallback ?? '').trim().split('\n').filter(Boolean).join('\n\n');
}

/** Today's date in Sydney as YYYY-MM-DD. */
export function todayInSydney(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
