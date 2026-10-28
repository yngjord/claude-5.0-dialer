import type { ContactStatus, Disposition, PickupStatus } from './constants';
import type { LeadInput } from './leads';

// Row shapes of the Supabase tables (supabase/migrations). Timestamps are ISO strings.

export type Role = 'team' | 'admin';

export interface Me {
  userId: string;
  email: string;
  role: Role;
  displayName: string;
}

export interface DialerUser {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  /** Hosted profile picture link (profiles.avatar_url). */
  avatar_url?: string | null;
}

export interface PhoneNumber {
  id: string;
  e164: string;
  twilio_sid: string | null;
  label: string | null;
  client_name: string | null;
  is_default: boolean;
  voicemail_greeting_path: string | null;
  created_at: string;
}

/** draft: admins only. paused: visible to the team, can't be opened. completed: set when every contact is wrapped up. */
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface Campaign {
  id: string;
  name: string;
  client_name: string;
  airtable_client_id: string;
  caller_number_id: string | null;
  status: CampaignStatus;
  created_at: string;
}

export interface CampaignStats {
  campaign_id: string;
  contacts_total: number;
  contacts_remaining: number;
  dials_today: number;
  connects_today: number;
  dials_total: number;
  connects_total: number;
}

export interface Contact {
  id: string;
  campaign_id: string;
  /** The campaign's client (set by the database). Duplicates are checked per client. */
  airtable_client_id: string | null;
  client_name: string | null;
  full_name: string | null;
  first_name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  phone_e164: string;
  phone_raw: string | null;
  linkedin: string | null;
  website: string | null;
  custom: Record<string, string>;
  status: ContactStatus;
  /** Callback: the rep who booked it (only they get the contact back). The time is next_attempt_at. */
  callback_user_id: string | null;
  attempts: number;
  last_called_at: string | null;
  next_attempt_at: string | null;
  last_disposition: string | null;
  locked_by: string | null;
  locked_at: string | null;
  airtable_lead_id: string | null;
  created_at: string;
}

export interface CallRow {
  id: string;
  direction: 'outbound' | 'inbound';
  kind: 'call' | 'voicemail';
  source: 'dialer' | 'justcall';
  campaign_id: string | null;
  contact_id: string | null;
  user_id: string | null;
  agent_name: string | null;
  client_name: string | null;
  campaign_name: string | null;
  full_name: string | null;
  email: string | null;
  company: string | null;
  linkedin: string | null;
  website: string | null;
  phone_e164: string | null;
  from_number: string | null;
  to_number: string | null;
  twilio_call_sid: string | null;
  twilio_status: string | null;
  answered_by: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  pickup_status: PickupStatus | null;
  pickup_source: 'twilio' | 'agent' | 'import';
  disposition: Disposition | null;
  notes: string | null;
  wrapped_up_at: string | null;
  recording_sid: string | null;
  recording_path: string | null;
  recording_duration_s: number | null;
  transcript_status: 'pending' | 'completed' | 'failed' | 'skipped' | null;
  transcript: string | null;
  transcript_json: TranscriptTurn[] | null;
  /** When the transcript was written to the Airtable lead this call created. */
  transcript_synced_at: string | null;
  visible: boolean;
  airtable_lead_id: string | null;
  lead_sync_error: string | null;
  read_at: string | null;
  justcall_call_id: number | null;
  updated_at: string;
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  start: number | null;
}

export interface SmsMessage {
  id: string;
  direction: 'outbound' | 'inbound';
  contact_id: string | null;
  user_id: string | null;
  phone_e164: string;
  our_number: string;
  body: string;
  twilio_sid: string | null;
  status: string | null;
  error: string | null;
  read_at: string | null;
  created_at: string;
}

export interface CallStatsRow {
  day: string;
  user_id: string | null;
  agent_name: string | null;
  dials: number;
  connects: number;
  machine: number;
  unanswered: number;
  appointments: number;
  follow_ups: number;
  talk_seconds: number;
}

// API request/response shapes (netlify/functions)

export interface WrapUpRequest {
  callId: string;
  pickupStatus: PickupStatus;
  disposition: Disposition;
  notes: string;
  /** Callback only: when to call back (ISO timestamp). */
  callbackAt?: string | null;
  lead?: LeadInput;
}

export interface WrapUpResponse {
  ok: true;
  leadId: string | null;
  /** Set when the call was saved but the Airtable Lead couldn't be created. Retry by submitting again. */
  leadError: string | null;
}

export interface AirtableClient {
  id: string;
  name: string;
  status: string | null;
}

export interface CallMediaResponse {
  recordingUrl: string | null;
  transcript: string | null;
  transcriptJson: TranscriptTurn[] | null;
  transcriptStatus: CallRow['transcript_status'];
}

export interface SmsSendRequest {
  to: string;
  body: string;
  contactId?: string | null;
}

export interface AvailableNumber {
  phoneNumber: string;
  locality: string | null;
  region: string | null;
  sms: boolean;
  voice: boolean;
}

export interface AvailableNumbersResponse {
  numbers: AvailableNumber[];
  /** Monthly cost per number, as Twilio bills it. */
  price: { amount: number; currency: string } | null;
  /** Whether the AU regulatory bundle is approved, which Twilio requires before selling AU mobiles. */
  bundleReady: boolean;
  bundleStatus: string | null;
}

export interface BuyNumberRequest {
  phoneNumber: string;
  clientName: string;
  label?: string | null;
}

/** Which Twilio settings are in Netlify (never the values themselves). */
export interface TwilioStatus {
  keys: boolean;
  authToken: boolean;
  twimlApp: boolean;
  intelligence: boolean;
  /** The address Twilio's webhooks will point at if setup runs now. */
  siteUrl: string;
}

export interface TwilioSetupResponse {
  twimlAppSid: string;
  intelligenceServiceSid: string | null;
  transcriptLanguage: string | null;
  transcriptsSkipped: string | null;
  numbersUpdated: string[];
  log: string[];
}

/** A lead in Airtable Leads that the logged-in rep created (Leads → Attributed to = their email). */
export interface MyLead {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  clientId: string | null;
  clientName: string | null;
  clientLogo: string | null;
  stage: string | null;
  /** YYYY-MM-DD */
  bookedFor: string | null;
  timeBookedFor: string | null;
  /** When the lead was created (Leads → Record Created), ISO timestamp. */
  opened: string;
  notes: string | null;
}

/** POST /api/leads: a booking added by hand from the Leads tab. */
export type { ManualBookingInput as NewBookingRequest } from './leads';
export interface NewBookingResponse {
  leadId: string;
}

/** GET /api/admin/twilio-balance */
export interface TwilioBalance {
  balance: number;
  currency: string;
}
