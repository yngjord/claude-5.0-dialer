// TEMPORARY: one-off JustCall backfill (Oct 2026). Delete with _lib/jcBackfill.ts and jc-backfill.ts.
import { db, must } from './_lib/db';
import { requireBackfillKey, loadJustCallApi, loadJustCallStorage, toMp3 } from './_lib/jcBackfill';
import { RECORDINGS_BUCKET } from './_lib/media';

/**
 * POST /.netlify/functions/jc-backfill-recordings-background: copies JustCall recordings (public S3 links from
 * Airtable "JustCall Storage") into the recordings bucket as MP3, for imported JustCall calls that don't have one yet.
 * Runs for up to ~13 minutes per call (background functions get 15); call again until none are left.
 */
export default async (req: Request) => {
  try {
    requireBackfillKey(req);
  } catch {
    return;
  }
  const deadline = Date.now() + 13 * 60_000;
  const { byCallId } = await loadJustCallStorage();
  // JustCall's API has the recording link for calls Airtable never captured.
  const api = process.env.JUSTCALL_API_KEY ? await loadJustCallApi().catch(() => null) : null;
  const apiByCallId = new Map([...(api?.values() ?? [])].map((a) => [a.callId, a.recording]));
  const failed = new Set<string>();
  let copied = 0;

  while (Date.now() < deadline) {
    const skip = failed.size ? [...failed].join(',') : '00000000-0000-0000-0000-000000000000';
    const batch = must(
      await db()
        .from('dialer_calls')
        .select('id, justcall_call_id')
        .eq('source', 'justcall')
        .not('justcall_call_id', 'is', null)
        .is('recording_path', null)
        .not('id', 'in', `(${skip})`)
        .order('started_at')
        .limit(8),
    ) as { id: string; justcall_call_id: number }[];
    if (!batch.length) break;

    await Promise.all(
      batch.map(async (c) => {
        try {
          const url = byCallId.get(c.justcall_call_id)?.recording ?? apiByCallId.get(c.justcall_call_id);
          if (!url) throw new Error('no recording link in JustCall Storage');
          const res = await fetch(url);
          if (!res.ok) throw new Error(`download ${res.status}`);
          const mp3 = toMp3(Buffer.from(await res.arrayBuffer()));
          const path = `${c.id}.mp3`;
          const { error } = await db().storage.from(RECORDINGS_BUCKET).upload(path, mp3, { contentType: 'audio/mpeg', upsert: true });
          if (error) throw new Error(`upload: ${error.message}`);
          must(await db().from('dialer_calls').update({ recording_path: path }).eq('id', c.id));
          copied++;
        } catch (err) {
          failed.add(c.id);
          console.error('JC backfill: recording failed', c.id, c.justcall_call_id, err instanceof Error ? err.message : err);
        }
      }),
    );
  }
  console.log(`JC backfill: copied ${copied} recordings, ${failed.size} failed this run`, [...failed]);
};
