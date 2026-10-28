import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { addToBlocklist } from './_lib/blocklist';
import { syncLeadTranscript } from './_lib/leadTranscript';
import { loadMediaCall, processRecording, storeTranscript } from './_lib/media';

/**
 * Every 10 minutes: finishes recordings and transcripts the webhooks didn't (timeouts, Twilio retries), adds human
 * pickups to the Airtable blocklist where the wrap-up's attempt failed, copies finished transcripts to their Airtable
 * leads where that didn't happen (including leads made before this existed), and closes inbound calls where the caller
 * hung up without leaving a message.
 */
export default async () => {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();

  const recordings = must(
    await db()
      .from('dialer_calls')
      .select('id')
      .not('recording_sid', 'is', null)
      .or('recording_path.is.null,transcript_status.is.null')
      .lt('updated_at', twoMinutesAgo)
      .limit(10),
  ) as { id: string }[];
  for (const { id } of recordings) {
    const call = await loadMediaCall(id);
    if (call) await processRecording(call).catch((err) => console.error('Sweep: recording failed', id, err));
  }

  const transcripts = must(
    await db().from('dialer_calls').select('id').eq('transcript_status', 'pending').lt('updated_at', twoMinutesAgo).order('updated_at').limit(20),
  ) as { id: string }[];
  for (const { id } of transcripts) {
    const call = await loadMediaCall(id);
    if (call) await storeTranscript(call).catch((err) => console.error('Sweep: transcript failed', id, err));
  }

  // Finished transcripts whose call created a lead, not yet written to it.
  const leadTranscripts = must(
    await db()
      .from('dialer_calls')
      .select('id')
      .not('airtable_lead_id', 'is', null)
      .eq('transcript_status', 'completed')
      .is('transcript_synced_at', null)
      .limit(20),
  ) as { id: string }[];
  for (const { id } of leadTranscripts) {
    await syncLeadTranscript(id).catch((err) => console.error('Sweep: lead transcript failed', id, err));
  }

  // Human pickups wrapped up 5+ minutes ago (the wrap-up's own attempt has finished) and still not on the blocklist.
  const blocklist = must(
    await db()
      .from('dialer_calls')
      .select('id')
      .eq('source', 'dialer')
      .eq('pickup_status', 'Human Pickup')
      .is('blocklist_record_id', null)
      .not('wrapped_up_at', 'is', null)
      .lt('wrapped_up_at', new Date(Date.now() - 5 * 60_000).toISOString())
      .gt('wrapped_up_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .limit(20),
  ) as { id: string }[];
  for (const { id } of blocklist) {
    await addToBlocklist(id).catch((err) => console.error('Sweep: blocklist failed', id, err));
  }

  must(
    await db()
      .from('dialer_calls')
      .update({ twilio_status: 'completed' })
      .eq('direction', 'inbound')
      .eq('twilio_status', 'in-progress')
      .lt('started_at', new Date(Date.now() - 10 * 60_000).toISOString()),
  );
};

export const config: Config = { schedule: '*/10 * * * *' };
