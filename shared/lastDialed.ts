import { linkedinHandle } from './clay';
import { normalizeCallable } from './phone';

/** What Clay posts to /api/lookup/last-dialed. A phone number, a LinkedIn profile, or both. */
export interface LastDialedRequest {
  /** The client's name as it is in the dialer (any letter case), or its Airtable client record id (rec…). */
  client: string;
  /** Any format: "0412 345 678", "61412345678", "+61 412 345 678", 412345678. */
  phone?: string | number | null;
  linkedin?: string | null;
}

export interface LastDialedResponse {
  found: boolean;
  /** The client as stored in the dialer. */
  client: string;
  /** The phone number looked up, standardised (+61…), or null if none was sent or it wasn't a valid AU/NZ number. */
  phone: string | null;
  linkedin_handle: string | null;
  /** How the last call was matched to the request. */
  matched_by: 'phone' | 'linkedin' | null;
  /** ISO timestamp of the most recent outbound call, or null. */
  last_dialed_at: string | null;
  days_since_last_dial: number | null;
  last_call_id: string | null;
  last_disposition: string | null;
  last_campaign: string | null;
  /** Outbound calls to this person for this client, all time. */
  times_dialed: number;
}

export type LastDialedLookup = {
  client: string;
  clientIsAirtableId: boolean;
  phone: string | null;
  linkedin: string | null;
};

/** Checks and standardises the request. Errors are written for whoever set up the Clay column. */
export function parseLastDialedRequest(body: unknown): { ok: true; lookup: LastDialedLookup } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<Record<keyof LastDialedRequest, unknown>>;
  const client = typeof b.client === 'string' ? b.client.trim() : '';
  if (!client)
    return {
      ok: false,
      error: 'Send "client": the client name as it is in the dialer, or its Airtable client record id (rec…).',
    };

  const rawPhone = typeof b.phone === 'number' ? String(b.phone) : typeof b.phone === 'string' ? b.phone.trim() : '';
  const rawLinkedin = typeof b.linkedin === 'string' ? b.linkedin.trim() : '';
  if (!rawPhone && !rawLinkedin) return { ok: false, error: 'Send "phone" or "linkedin" (or both).' };

  const phone = rawPhone ? normalizeCallable(rawPhone) : null;
  const linkedin = rawLinkedin ? linkedinHandle(rawLinkedin) : null;
  // Only refused when nothing usable was sent: a bad number with a good LinkedIn still gets looked up.
  if (!phone?.ok && !linkedin) {
    if (rawPhone && phone && !phone.ok)
      return {
        ok: false,
        error: `Couldn't read the phone number "${rawPhone}": ${phone.reason}.`,
      };
    return {
      ok: false,
      error: 'That doesn’t look like a LinkedIn profile URL (it needs linkedin.com/in/…).',
    };
  }
  return {
    ok: true,
    lookup: {
      client,
      clientIsAirtableId: /^rec[A-Za-z0-9]{14}$/.test(client),
      phone: phone?.ok ? phone.e164 : null,
      linkedin,
    },
  };
}

/** A Postgres regex matching that profile in a stored URL, whatever comes after the handle (/, ?, # or nothing). */
export function linkedinPattern(handle: string): string {
  return `linkedin\\.com/in/${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\?|#|$)`;
}

export function daysSince(iso: string, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}
