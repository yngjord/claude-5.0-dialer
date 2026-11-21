// Option names match the Airtable selects JustCall used ('JustCall Storage' → Pickup Status / Disposition) exactly,
// so the portal's badges and reports read the same as they did for JustCall calls.

export const PICKUP_STATUSES = ['Human Pickup', 'Machine Pickup', 'Unanswered', 'Unclassified Pickup', 'Busy', 'Failed'] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];

export const DISPOSITIONS = [
  'Interested - Appointment Set',
  'Interested - Needs Follow-Up',
  'Referral',
  'Callback',
  'Not Interested',
  'Left Voicemail',
  'No Answer',
  'Unqualified Lead',
  'Wrong Number',
  'Do Not Call',
  'Disconnected Number',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const APPOINTMENT_SET: Disposition = 'Interested - Appointment Set';
export const NEEDS_FOLLOW_UP: Disposition = 'Interested - Needs Follow-Up';
/**
 * The person called pointed us to someone else: makes two linked CRM leads, the parent (the person called, with the
 * call recording) and a sublead (the person they referred us to).
 */
export const REFERRAL: Disposition = 'Referral';
/** Not a lead yet: the rep books a time to call back, and the contact waits for them (see dialer_claim_next). */
export const CALLBACK: Disposition = 'Callback';

/** Dispositions that create a record in Airtable Leads. */
export const LEAD_DISPOSITIONS: readonly Disposition[] = [APPOINTMENT_SET, NEEDS_FOLLOW_UP, REFERRAL];

/** A call is "connected" (a real conversation) only when Pickup Status is exactly this value. Same rule as the portal. */
export const CONNECTED_PICKUP_STATUS: PickupStatus = 'Human Pickup';

export const CONTACT_STATUSES = ['new', 'callback', 'done', 'do_not_call', 'bad_number'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const isPickupStatus = (v: unknown): v is PickupStatus => PICKUP_STATUSES.includes(v as PickupStatus);
export const isDisposition = (v: unknown): v is Disposition => DISPOSITIONS.includes(v as Disposition);
