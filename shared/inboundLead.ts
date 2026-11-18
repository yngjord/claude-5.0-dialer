import { normalizePhone } from './phone';

/** Kept on the contact for matching re-sent submissions, but not shown to reps. */
export const INTERNAL_CUSTOM_KEYS: readonly string[] = ['portal_submission_id', 'submitted_by'];

/** What Clay posts to /api/inbound/lead for a warm lead a client submitted in the portal (after phone enrichment). */
export interface InboundLeadRequest {
  airtable_client_id: string;
  submission_id: string | number;
  full_name: string;
  phone: string | number;
  /** The client's note about the lead: why they're warm, what to mention. Shown to the rep while dialling. */
  context: string;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  linkedin?: string | null;
  website?: string | null;
  submitted_by?: string | null;
}

export interface InboundLeadResponse {
  status: 'created' | 'updated';
  contact_id: string;
  campaign_id: string;
  campaign_name: string;
}

export type ValidLead = {
  airtableClientId: string;
  submissionId: string;
  fullName: string;
  firstName: string;
  phone: string;
  phoneRaw: string;
  context: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  submittedBy: string | null;
};

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const optional = (v: unknown) => text(v) || null;

/** Checks and tidies Clay's payload. Returns the problems (for a 400) or the cleaned lead. */
export function validateInboundLead(body: Partial<InboundLeadRequest> | null): { ok: true; lead: ValidLead } | { ok: false; errors: string[] } {
  const b = body ?? {};
  const errors: string[] = [];
  const airtableClientId = text(b.airtable_client_id);
  if (!/^rec[A-Za-z0-9]{14}$/.test(airtableClientId)) errors.push('airtable_client_id must be an Airtable Client record id (rec…).');
  const submissionId = text(b.submission_id);
  if (!submissionId) errors.push('submission_id is required.');
  const fullName = text(b.full_name);
  if (!fullName) errors.push('full_name is required.');
  const context = text(b.context);
  if (!context) errors.push('context is required.');
  const phone = normalizePhone(b.phone);
  if (!phone.ok) errors.push(`phone: ${phone.reason}. It must be an Australian or New Zealand mobile.`);
  if (errors.length || !phone.ok) return { ok: false, errors };
  return {
    ok: true,
    lead: {
      airtableClientId,
      submissionId,
      fullName,
      firstName: fullName.split(/\s+/)[0],
      phone: phone.e164,
      phoneRaw: text(b.phone),
      context,
      title: optional(b.title),
      company: optional(b.company),
      email: optional(b.email)?.toLowerCase() ?? null,
      linkedin: optional(b.linkedin),
      website: optional(b.website),
      submittedBy: optional(b.submitted_by),
    },
  };
}

/** A later submission for someone already in the campaign adds its context under the earlier one. */
export function mergeContext(existing: string | null, incoming: string, date: string): string {
  const prev = existing?.trim();
  if (!prev || prev === incoming) return incoming;
  if (prev.includes(incoming)) return prev;
  return `${prev}\n\n— New submission (${date}): ${incoming}`;
}
