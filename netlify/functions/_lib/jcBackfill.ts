// TEMPORARY: one-off JustCall backfill (Oct 2026). Delete this file and the two jc-backfill functions afterwards.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Mp3Encoder } from '@breezystack/lamejs';
import { listAll } from './airtable';
import { HttpError } from './http';

// sha256 of the one-off key held by the person running the backfill (the key itself isn't in the repo).
const KEY_HASH = '630eeaf9a8cbbbfdbc567fc287607cf494ffc9cb4d245a3c382e3a44eca63cb2';

export function requireBackfillKey(req: Request): void {
  const key = req.headers.get('x-backfill-key') ?? '';
  const got = createHash('sha256').update(key).digest();
  if (!key || !timingSafeEqual(got, Buffer.from(KEY_HASH, 'hex'))) throw new HttpError(403, 'Forbidden');
}

export interface JcRecord {
  id: string;
  callId: number;
  contactId: number | null;
  callDate: string | null;
  phone: string;
  recording: string | null;
  created: number;
  disposition: string | null;
  notes: string;
}

/** Every Airtable "JustCall Storage" record, by phone number (digits only). */
export async function loadJustCallStorage(): Promise<{ byPhone: Map<string, JcRecord[]>; byCallId: Map<number, JcRecord> }> {
  const records = await listAll<{
    'Call ID': number;
    'Contact ID': number;
    'Call Date': string;
    'Phone Number': number;
    'Call Recording': string;
    Created: string;
    Disposition: string;
    'Call notes': string;
  }>('JustCall Storage', {
    filterByFormula: "{Call ID} != ''",
    fields: ['Call ID', 'Contact ID', 'Call Date', 'Phone Number', 'Call Recording', 'Created', 'Disposition', 'Call notes'],
  });
  const byPhone = new Map<string, JcRecord[]>();
  const byCallId = new Map<number, JcRecord>();
  for (const r of records) {
    const f = r.fields;
    if (!f['Call ID'] || !f['Phone Number']) continue;
    const rec: JcRecord = {
      id: r.id,
      callId: f['Call ID'],
      contactId: f['Contact ID'] ?? null,
      callDate: f['Call Date'] ?? null,
      phone: String(f['Phone Number']),
      recording: f['Call Recording']?.trim() || null,
      created: Date.parse(f.Created ?? r.createdTime),
      disposition: f.Disposition ?? null,
      notes: (f['Call notes'] ?? '').trim(),
    };
    byCallId.set(rec.callId, rec);
    const list = byPhone.get(rec.phone) ?? [];
    list.push(rec);
    byPhone.set(rec.phone, list);
  }
  return { byPhone, byCallId };
}

/** 16-bit PCM WAV → MP3 (32 kbps, both channels kept so rep and prospect stay separate). */
export function wavToMp3(buf: Buffer): Buffer {
  let off = 12;
  let fmt: { format: number; ch: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') data = buf.subarray(body, Math.min(buf.length, body + size));
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Unreadable WAV');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`Unsupported WAV (format ${fmt.format}, ${fmt.bits}-bit)`);
  const pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)));
  const frames = Math.floor(pcm.length / fmt.ch);
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = pcm[i * fmt.ch];
    right[i] = pcm[i * fmt.ch + (fmt.ch > 1 ? 1 : 0)];
  }
  const stereo = fmt.ch > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, fmt.rate, 32);
  const out: Uint8Array[] = [];
  for (let i = 0; i < frames; i += 1152) {
    out.push(stereo ? enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152)) : enc.encodeBuffer(left.subarray(i, i + 1152)));
  }
  out.push(enc.flush());
  return Buffer.concat(out.map((b) => Buffer.from(b)));
}

/** A JustCall recording as MP3: WAVs are converted, files that are already MP3 are kept as they are. */
export function toMp3(buf: Buffer): Buffer {
  if (buf.toString('ascii', 0, 4) === 'RIFF') return wavToMp3(buf);
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return buf;
  throw new Error(`Unknown audio format (${buf.subarray(0, 4).toString('hex')})`);
}

export interface JcApiCall {
  callId: number;
  contactId: number | null;
  recording: string | null;
  hasAi: boolean;
}

/** Every Sales Dialer call from JustCall's API (keys in Netlify env), by Twilio call SID. */
export async function loadJustCallApi(): Promise<Map<string, JcApiCall>> {
  const key = process.env.JUSTCALL_API_KEY?.trim();
  const secret = process.env.JUSTCALL_API_SECRET?.trim();
  if (!key || !secret) throw new HttpError(503, 'JustCall keys missing');
  const out = new Map<string, JcApiCall>();
  for (let page = 0; page < 100; page++) {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`https://api.justcall.io/v2.1/sales_dialer/calls?per_page=100&page=${page}&sort=id`, { headers: { Authorization: `${key}:${secret}`, Accept: 'application/json' } });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    if (!res?.ok) throw new HttpError(502, `JustCall API page ${page}: ${res?.status}`);
    const body = (await res.json()) as {
      data: { call_id: number; call_sid: string; contact_id: number; call_info?: { recording?: string }; justcall_ai?: Record<string, unknown> }[];
      next_page_link?: string;
    };
    for (const c of body.data ?? []) {
      out.set(c.call_sid, { callId: c.call_id, contactId: c.contact_id ?? null, recording: c.call_info?.recording?.trim() || null, hasAi: !!c.justcall_ai && Object.keys(c.justcall_ai).length > 0 });
    }
    if (!body.next_page_link || !body.data?.length) break;
  }
  return out;
}
