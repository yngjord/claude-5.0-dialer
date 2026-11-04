import type { Config } from '@netlify/functions';
import { ATTRIBUTED_TO_FIELD_NAME, LEAD_FIELDS as F } from '../../shared/leads';
import { decodeEntities } from '../../shared/text';
import type { MyLead } from '../../shared/types';
import { listAll } from './_lib/airtable';
import { requireDialerUser } from './_lib/auth';
import { handler, json } from './_lib/http';

type Attachment = { url: string; thumbnails?: { large?: { url: string } } };

// Bookings only: a rep's Leads page shows the meetings they've booked (and those since closed), from cold calls, for
// clients that are still active.
const STAGES = ['Booking', 'Closed'];

/**
 * GET /api/my-leads: the Airtable Leads the logged-in rep created (Leads → "Attributed to - new dialer" = their login
 * email), where Channel is Cold Call, Stage is Booking or Closed, and the linked client's Status is Active. Newest
 * first, with each client's name and logo.
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  const email = me.email.trim().toLowerCase().replace(/'/g, "\\'");
  if (!email) return json([]);

  // Read by field id, so renaming a Leads field in Airtable doesn't break this page. The formula has to use names.
  const leads = await listAll<Record<string, string & string[]>>('Leads', {
    filterByFormula: [
      'AND(',
      `LOWER(TRIM({${ATTRIBUTED_TO_FIELD_NAME}})) = '${email}',`,
      `{Channel} = 'Cold Call',`,
      // A lookup of the client's Status: exactly 'Active' (a plain FIND would also match 'Inactive').
      `ARRAYJOIN({Linked Client Status}) = 'Active',`,
      `OR(${STAGES.map((s) => `{Stage} = '${s}'`).join(', ')})`,
      ')',
    ].join(' '),
    fields: [F.fullName, F.email, F.phone, F.linkedin, F.client, F.stage, F.dateBookedFor, F.timeBookedFor, F.recordCreated, F.notes],
    byFieldId: true,
  });

  const clientIds = [...new Set(leads.flatMap((l) => l.fields[F.client] ?? []))];
  const clients = clientIds.length
    ? await listAll<{ 'Client Company': string; 'Client Logo Image': Attachment[] }>('Clients', {
        filterByFormula: `OR(${clientIds.map((id) => `RECORD_ID() = '${id}'`).join(', ')})`,
        fields: ['Client Company', 'Client Logo Image'],
      })
    : [];
  const byId = new Map(clients.map((c) => [c.id, c.fields]));

  const rows: MyLead[] = leads
    .map((l) => {
      const clientId = l.fields[F.client]?.[0] ?? null;
      const client = clientId ? byId.get(clientId) : undefined;
      const logo = client?.['Client Logo Image']?.[0];
      const text = (v: string | undefined) => (v?.trim() ? decodeEntities(v.trim()) : null);
      return {
        id: l.id,
        fullName: text(l.fields[F.fullName]),
        email: l.fields[F.email]?.trim() || null,
        phone: l.fields[F.phone]?.trim() || null,
        linkedin: l.fields[F.linkedin]?.trim() || null,
        clientId,
        clientName: client?.['Client Company']?.trim() || null,
        clientLogo: logo?.thumbnails?.large?.url ?? logo?.url ?? null,
        stage: l.fields[F.stage] ?? null,
        bookedFor: l.fields[F.dateBookedFor] ?? null,
        timeBookedFor: l.fields[F.timeBookedFor]?.trim() || null,
        opened: l.fields[F.recordCreated] ?? l.createdTime,
        notes: text(l.fields[F.notes]),
      };
    })
    .sort((a, b) => b.opened.localeCompare(a.opened));
  return json(rows);
});

export const config: Config = { path: '/api/my-leads', method: 'GET' };
