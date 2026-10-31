// TEMPORARY: one-off JustCall backfill (Oct 2026). Delete with _lib/jcBackfill.ts and jc-backfill-recordings-background.ts.
import type { Config } from '@netlify/functions';
import { updateRecord, listAll } from './_lib/airtable';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';
import { loadJustCallStorage, requireBackfillKey, type JcRecord } from './_lib/jcBackfill';
import { LEAD_FIELDS } from '../../shared/leads';

type Body =
  | { action: 'import'; calls: Record<string, unknown>[] }
  | { action: 'match' }
  | { action: 'status' }
  | { action: 'leads'; dry?: boolean; baseUrl: string };

interface JcCall {
  id: string;
  phone_e164: string | null;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
  disposition: string | null;
  justcall_call_id: number | null;
}

const sydneyDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
// Notes were saved as "[JustCall: <disposition>] <notes>" when the disposition didn't fit the dialer's list.
const splitNotes = (notes: string | null) => {
  const m = /^\[JustCall: ([^\]]+)\]\s*/.exec(notes ?? '');
  return { code: m?.[1] ?? null, text: (m ? (notes ?? '').slice(m[0].length) : (notes ?? '')).trim() };
};

async function allJcCalls(): Promise<JcCall[]> {
  const out: JcCall[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(
      await db().from('dialer_calls').select('id, phone_e164, started_at, ended_at, notes, justcall_call_id, disposition').eq('source', 'justcall').order('started_at').range(from, from + 999),
    ) as JcCall[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export default handler(async (req) => {
  requireBackfillKey(req);
  const body = await readJson<Body>(req);

  if (body.action === 'import') {
    const rows = body.calls.map((c) => ({ ...c, source: 'justcall', direction: 'outbound', kind: 'call', twilio_status: 'completed', pickup_source: 'import', visible: true }));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const res = must(await db().from('dialer_calls').upsert(rows.slice(i, i + 200), { onConflict: 'twilio_call_sid', ignoreDuplicates: true }).select('id')) as { id: string }[];
      inserted += res.length;
    }
    return json({ received: rows.length, inserted });
  }

  if (body.action === 'match') {
    const { byPhone } = await loadJustCallStorage();
    const calls = await allJcCalls();
    const used = new Set(calls.map((c) => c.justcall_call_id).filter(Boolean));
    const unmatched: { id: string; phone: string | null; at: string; candidates: number }[] = [];
    let matched = 0;
    let already = 0;
    for (const c of calls) {
      if (c.justcall_call_id) {
        already++;
        continue;
      }
      const phone = (c.phone_e164 ?? '').replace(/\D/g, '');
      const cands = (byPhone.get(phone) ?? []).filter((r) => !used.has(r.callId));
      const end = Date.parse(c.ended_at ?? c.started_at);
      // 1) Airtable's record is created as the call ends: closest within 2 minutes before to 20 minutes after.
      let pick: JcRecord | undefined = cands
        .filter((r) => r.created >= end - 120_000 && r.created <= end + 20 * 60_000)
        .sort((a, b) => Math.abs(a.created - end) - Math.abs(b.created - end))[0];
      // 2) Records imported in bulk: same call date, narrowed by disposition and notes when there are several.
      if (!pick) {
        const day = sydneyDate(c.started_at);
        let same = cands.filter((r) => r.callDate === day);
        const { code, text } = splitNotes(c.notes);
        const disposition = code ?? c.disposition;
        if (same.length > 1 && text) same = same.filter((r) => r.notes === text).length ? same.filter((r) => r.notes === text) : same;
        if (same.length > 1 && disposition) same = same.filter((r) => r.disposition === disposition).length ? same.filter((r) => r.disposition === disposition) : same;
        if (same.length === 1) pick = same[0];
      }
      if (!pick) {
        unmatched.push({ id: c.id, phone: c.phone_e164, at: c.started_at, candidates: cands.length });
        continue;
      }
      used.add(pick.callId);
      must(await db().from('dialer_calls').update({ justcall_call_id: pick.callId, justcall_contact_id: pick.contactId }).eq('id', c.id));
      matched++;
    }
    return json({ calls: calls.length, already, matched, unmatched: unmatched.length, unmatchedList: unmatched });
  }

  if (body.action === 'status') {
    const calls = await allJcCalls();
    const { count } = await db().from('dialer_calls').select('id', { count: 'exact', head: true }).eq('source', 'justcall').not('recording_path', 'is', null);
    return json({ calls: calls.length, matched: calls.filter((c) => c.justcall_call_id).length, recordings: count ?? 0 });
  }

  if (body.action === 'leads') {
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(body.baseUrl ?? '')) throw new HttpError(400, 'baseUrl required');
    const { byCallId } = await loadJustCallStorage();
    const s3ToCallId = new Map<string, number>();
    for (const r of byCallId.values()) if (r.recording) s3ToCallId.set(r.recording, r.callId);
    const calls = must(
      await db().from('dialer_calls').select('id, justcall_call_id, recording_path, airtable_lead_id').eq('source', 'justcall').not('justcall_call_id', 'is', null),
    ) as { id: string; justcall_call_id: number; recording_path: string | null; airtable_lead_id: string | null }[];
    const byJc = new Map(calls.map((c) => [c.justcall_call_id, c]));

    const leads = await listAll<Record<string, string>>('Leads', {
      filterByFormula: "FIND('jc-recordings', {Call Recording Link})",
      fields: [LEAD_FIELDS.callRecordingLink],
      byFieldId: true,
    });
    const done: { lead: string; call: string }[] = [];
    const missing: { lead: string; link: string; reason: string }[] = [];
    for (const l of leads) {
      const link = (l.fields[LEAD_FIELDS.callRecordingLink] ?? '').trim();
      const jcId = s3ToCallId.get(link);
      const call = jcId ? byJc.get(jcId) : undefined;
      if (!jcId) missing.push({ lead: l.id, link, reason: 'not in JustCall Storage' });
      else if (!call) missing.push({ lead: l.id, link, reason: 'call not in the export' });
      else if (!call.recording_path) missing.push({ lead: l.id, link, reason: 'recording not copied yet' });
      else {
        if (!body.dry) {
          await updateRecord('Leads', l.id, { [LEAD_FIELDS.callRecordingLink]: `${body.baseUrl}/r/${call.id}.mp3` });
          if (!call.airtable_lead_id) must(await db().from('dialer_calls').update({ airtable_lead_id: l.id }).eq('id', call.id));
        }
        done.push({ lead: l.id, call: call.id });
      }
    }
    return json({ dry: !!body.dry, leadsWithJustCallLinks: leads.length, repointed: done.length, missing: missing.length, missingList: missing });
  }

  throw new HttpError(400, 'Unknown action');
});

export const config: Config = { path: '/api/jc-backfill', method: 'POST' };
