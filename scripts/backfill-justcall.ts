/**
 * Copies the JustCall history out of Airtable ('JustCall Storage' + 'Cold Call Transcripts') into the Supabase
 * `dialer_calls` table, including the recordings (JustCall's links will stop working once that account is closed).
 * Safe to re-run: rows are upserted on justcall_call_id, and recordings already copied are skipped.
 *
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=app… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npm run backfill:justcall -- [--dry-run] [--skip-recordings]
 */
import { isDisposition, isPickupStatus } from '../shared/constants';
import { decodeEntities } from '../shared/text';
import { normalizePhone } from '../shared/phone';
import { listAll } from '../netlify/functions/_lib/airtable';
import { db, must } from '../netlify/functions/_lib/db';
import { RECORDINGS_BUCKET } from '../netlify/functions/_lib/media';

// Table ids rather than names, so a rename in Airtable doesn't break this.
const JUSTCALL_TABLE = 'tblFoDRcBCALszMPt';
const TRANSCRIPTS_TABLE = 'tblK7ABk7xaES9Sbv';
const CLIENTS_TABLE = 'tblHHWS3bJLU34XwQ';
const LEADS_TABLE = 'tbl0UTD2jPoAeUEhG';

const dryRun = process.argv.includes('--dry-run');
const skipRecordings = process.argv.includes('--skip-recordings');

interface JustCallFields {
  'Call ID': number;
  'Contact ID': number;
  'Call Date': string;
  'Campaign Name': string;
  'Pickup Status': string;
  Disposition: string;
  'Phone Number': number | string;
  'Full Name': string;
  'Linkedin URL': string;
  'Call Recording': string;
  'Website/Domain': string;
  'Associated Client': string[];
  'Visible?': boolean;
  'Call notes': string;
  'Agent Name': string;
  Created: string;
}

interface TranscriptFields {
  'JustCall Call ID': string;
  'Formatted Transcript': string;
  'Associated Lead': string[];
}

const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** Created time when it's on the Call Date (Sydney), otherwise midnight Sydney on the Call Date. */
function startedAt(f: Partial<JustCallFields>, createdTime: string): string {
  const created = f.Created ?? createdTime;
  if (!f['Call Date']) return created;
  const createdDay = new Date(created).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  if (createdDay === f['Call Date']) return created;
  // 00:00 Sydney ≈ 13:00/14:00 UTC the previous day; use 00:00+10:00 as a stable approximation.
  return new Date(`${f['Call Date']}T00:00:00+10:00`).toISOString();
}

/**
 * Transcripts aren't keyed by call: their 'JustCall Call ID' holds a placeholder, and they link to a Lead instead.
 * Match each one to the call to that Lead's phone number that started closest before the transcript was created
 * (within 3 days), preferring connected calls. A numeric JustCall Call ID, if present, wins.
 */
async function matchTranscripts(
  transcripts: { createdTime: string; fields: Partial<TranscriptFields> }[],
  calls: { callId: number; phone: string | null; startedAt: string; pickup: string | null }[],
): Promise<Map<number, Partial<TranscriptFields>>> {
  const leadIds = [...new Set(transcripts.flatMap((t) => t.fields['Associated Lead'] ?? []))];
  const leadPhone = new Map<string, string>();
  for (let i = 0; i < leadIds.length; i += 50) {
    const chunk = leadIds.slice(i, i + 50);
    const leads = await listAll<{ 'Phone Number': string }>(LEADS_TABLE, {
      filterByFormula: `OR(${chunk.map((id) => `RECORD_ID() = '${id}'`).join(',')})`,
      fields: ['Phone Number'],
    });
    for (const l of leads) {
      const p = normalizePhone(l.fields['Phone Number']);
      if (p.ok) leadPhone.set(l.id, p.e164);
    }
  }

  const byPhone = new Map<string, typeof calls>();
  for (const c of calls) if (c.phone) byPhone.set(c.phone, [...(byPhone.get(c.phone) ?? []), c]);

  const out = new Map<number, Partial<TranscriptFields>>();
  for (const t of transcripts) {
    const direct = Number(t.fields['JustCall Call ID']);
    if (Number.isInteger(direct) && direct > 0) {
      out.set(direct, t.fields);
      continue;
    }
    const phone = leadPhone.get(t.fields['Associated Lead']?.[0] ?? '');
    const created = new Date(t.createdTime).getTime();
    const candidates = (byPhone.get(phone ?? '') ?? [])
      .map((c) => ({ c, gap: created - new Date(c.startedAt).getTime() }))
      .filter(({ c, gap }) => gap >= -3_600_000 && gap <= 3 * 86_400_000 && !out.has(c.callId))
      .sort((a, b) => Number(b.c.pickup === 'Human Pickup') - Number(a.c.pickup === 'Human Pickup') || Math.abs(a.gap) - Math.abs(b.gap));
    if (candidates[0]) out.set(candidates[0].c.callId, t.fields);
  }
  return out;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  console.log(`Reading Airtable…${dryRun ? ' (dry run)' : ''}`);
  const [calls, transcripts, clients] = await Promise.all([
    listAll<JustCallFields>(JUSTCALL_TABLE, { filterByFormula: 'TRUE()' }),
    listAll<TranscriptFields>(TRANSCRIPTS_TABLE, { filterByFormula: 'TRUE()' }),
    listAll<{ 'Client Company': string }>(CLIENTS_TABLE, { filterByFormula: 'TRUE()', fields: ['Client Company'] }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.fields['Client Company']?.trim() ?? null]));
  console.log(`${calls.length} calls, ${transcripts.length} transcripts, ${clients.length} clients`);

  const transcriptByCall = await matchTranscripts(
    transcripts,
    calls.flatMap(({ fields: f, createdTime }) => {
      if (typeof f['Call ID'] !== 'number') return [];
      const p = normalizePhone(f['Phone Number']);
      return [{ callId: f['Call ID'], phone: p.ok ? p.e164 : null, startedAt: startedAt(f, createdTime), pickup: f['Pickup Status'] ?? null }];
    }),
  );
  console.log(`${transcriptByCall.size} of ${transcripts.length} transcripts matched to a call`);

  let skipped = 0;
  const recordingUrls = new Map<number, string>();
  const unknownValues = new Map<string, number>();
  const note = (v: string) => unknownValues.set(v, (unknownValues.get(v) ?? 0) + 1);

  const rows = calls.flatMap(({ fields: f, createdTime }) => {
    const callId = f['Call ID'];
    if (typeof callId !== 'number') {
      skipped++;
      return [];
    }
    const phone = normalizePhone(f['Phone Number']);
    const pickup = text(f['Pickup Status']);
    const disposition = text(f.Disposition);
    if (pickup && !isPickupStatus(pickup)) note(`Pickup Status "${pickup}"`);
    if (disposition && !isDisposition(disposition)) note(`Disposition "${disposition}"`);
    const t = transcriptByCall.get(callId);
    const recording = text(f['Call Recording']);
    if (recording) recordingUrls.set(callId, recording);
    return [
      {
        source: 'justcall',
        direction: 'outbound',
        kind: 'call',
        justcall_call_id: callId,
        justcall_contact_id: typeof f['Contact ID'] === 'number' ? f['Contact ID'] : null,
        started_at: startedAt(f, createdTime),
        campaign_name: text(f['Campaign Name']) && decodeEntities(f['Campaign Name']!.trim()),
        client_name: f['Associated Client']?.[0] ? clientName.get(f['Associated Client'][0]) ?? null : null,
        pickup_status: pickup && isPickupStatus(pickup) ? pickup : null,
        pickup_source: 'import',
        disposition: disposition && isDisposition(disposition) ? disposition : null,
        phone_e164: phone.ok ? phone.e164 : f['Phone Number'] != null ? String(f['Phone Number']) : null,
        full_name: text(f['Full Name']),
        linkedin: text(f['Linkedin URL']),
        website: text(f['Website/Domain']),
        agent_name: text(f['Agent Name']),
        notes: text(f['Call notes']),
        visible: f['Visible?'] === true,
        transcript: t?.['Formatted Transcript']?.trim() || null,
        transcript_status: t?.['Formatted Transcript'] ? 'completed' : null,
        airtable_lead_id: t?.['Associated Lead']?.[0] ?? null,
      },
    ];
  });

  console.log(`${rows.length} calls to copy (${skipped} skipped without a Call ID)`);
  for (const [v, n] of unknownValues) console.log(`  ${n}× unknown ${v} → left empty`);
  if (dryRun) return;

  for (let i = 0; i < rows.length; i += 500) {
    must(await db().from('dialer_calls').upsert(rows.slice(i, i + 500), { onConflict: 'justcall_call_id' }));
    console.log(`  upserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }

  if (skipRecordings) return console.log('Skipping recordings.');

  // Copy recordings that aren't in Storage yet.
  const done = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const page = must(await db().from('dialer_calls').select('justcall_call_id').eq('source', 'justcall').not('recording_path', 'is', null).range(from, from + 999)) as { justcall_call_id: number }[];
    page.forEach((r) => done.add(r.justcall_call_id));
    if (page.length < 1000) break;
  }
  const todo = [...recordingUrls].filter(([id]) => !done.has(id));
  console.log(`Copying ${todo.length} recordings (${done.size} already copied)…`);

  let copied = 0;
  const failed: string[] = [];
  await pool(todo, 4, async ([callId, url]) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // JustCall's S3 links have no extension and may not send an audio content type; they're MP3s.
      const sent = res.headers.get('content-type')?.split(';')[0] ?? '';
      const type = sent.startsWith('audio/') ? sent : 'audio/mpeg';
      const ext = type.includes('wav') ? 'wav' : 'mp3';
      const path = `justcall/${callId}.${ext}`;
      const { error } = await db().storage.from(RECORDINGS_BUCKET).upload(path, await res.arrayBuffer(), { contentType: type, upsert: true });
      if (error) throw new Error(error.message);
      must(await db().from('dialer_calls').update({ recording_path: path }).eq('justcall_call_id', callId));
      if (++copied % 50 === 0) console.log(`  ${copied}/${todo.length}`);
    } catch (err) {
      failed.push(`${callId}: ${(err as Error).message}`);
    }
  });
  console.log(`Recordings copied: ${copied}. Failed: ${failed.length}`);
  failed.slice(0, 20).forEach((f) => console.log(`  ${f}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
