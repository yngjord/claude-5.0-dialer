import type { Config } from '@netlify/functions';
import { db, must } from './_lib/db';
import { loadMediaCall, processRecording, storeTranscript } from './_lib/media';

/**
 * Every 10 minutes: finishes recordings and transcripts the webhooks didn't (timeouts, Twilio retries), and closes
 * inbound calls where the caller hung up without leaving a message.
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
