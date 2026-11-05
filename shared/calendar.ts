/** A client's Google Calendar settings and connection (table dialer_client_calendars). */
export interface ClientCalendar {
  airtable_client_id: string;
  client_name: string;
  invites_enabled: boolean;
  meeting_minutes: number;
  title_template: string;
  description_template: string;
  google_email: string | null;
  status: 'not_connected' | 'connected' | 'disconnected';
  connected_at: string | null;
  last_error: string | null;
}

/** The meeting invite a rep sends with an Appointment Set (only when the client has invites switched on). */
export interface InviteInput {
  title: string;
  description: string;
  /** When the meeting starts (ISO). */
  startsAt: string;
  minutes: number;
  /** The time zone the rep booked in, e.g. Australia/Sydney (Google shows each guest their own time). */
  timeZone: string;
  /** Everyone to invite: the prospect first, then any extra guests. */
  guests: string[];
}

/** Whether a client's settings mean Appointment Set sends an invite. */
export const sendsInvites = (c: Pick<ClientCalendar, 'invites_enabled' | 'status'> | null | undefined) => !!c && c.invites_enabled && c.status === 'connected';

/** Invites are switched on but the calendar isn't connected (e.g. the host removed access): invites won't send. */
export const invitesBroken = (c: Pick<ClientCalendar, 'invites_enabled' | 'status'> | null | undefined) => !!c && c.invites_enabled && c.status !== 'connected';

/** Fills {{client}}, {{company}}, {{prospect}} and {{first_name}}; unknown or empty variables become blank. */
export function renderTemplate(template: string, vars: { client?: string | null; company?: string | null; prospect?: string | null; firstName?: string | null }): string {
  const values: Record<string, string> = {
    client: vars.client?.trim() ?? '',
    company: vars.company?.trim() ?? '',
    prospect: vars.prospect?.trim() ?? '',
    first_name: (vars.firstName?.trim() || vars.prospect?.trim().split(/\s+/)[0]) ?? '',
  };
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => values[k] ?? '')
    .replace(/\s+×\s*$|^\s*×\s+/g, '')
    .trim();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "a@x.com, b@y.com; c@z.com" → unique, trimmed addresses (invalid ones kept so validation can name them). */
export function parseGuests(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Problems with an invite; empty when it can be sent. */
export function validateInvite(invite: InviteInput, now = Date.now()): string[] {
  const errors: string[] = [];
  if (!invite.title?.trim()) errors.push('Invite title is required.');
  if (!invite.guests?.length) errors.push('Prospect email is required to send the invite.');
  const bad = (invite.guests ?? []).filter((g) => !EMAIL.test(g));
  if (bad.length) errors.push(`Check these email addresses: ${bad.join(', ')}.`);
  const start = new Date(invite.startsAt).getTime();
  if (Number.isNaN(start)) errors.push('Choose when the meeting is.');
  else if (start < now - 60 * 60_000) errors.push('The meeting time is in the past.');
  if (!Number.isInteger(invite.minutes) || invite.minutes < 5 || invite.minutes > 240) errors.push('Meeting length must be 5 to 240 minutes.');
  return errors;
}
