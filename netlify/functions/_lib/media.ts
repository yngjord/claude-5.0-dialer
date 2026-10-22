import { shouldTranscribe } from '../../../shared/pickup';
import type { CallRow, TranscriptTurn } from '../../../shared/types';
import { db, must } from './db';
import { env } from './http';
import { twilioAuthHeader, twilioClient } from './twilio';

export const RECORDINGS_BUCKET = 'recordings';

type MediaCall = Pick<
  CallRow,
  'id' | 'kind' | 'direction' | 'answered_by' | 'duration_s' | 'recording_sid' | 'recording_path' | 'recording_duration_s' | 'transcript_status' | 'agent_name' | 'full_name'
> & { transcript_sid: string | null };

const MEDIA_COLUMNS =
  'id, kind, direction, answered_by, duration_s, recording_sid, recording_path, recording_duration_s, transcript_status, transcript_sid, agent_name, full_name';

export async function loadMediaCall(callId: string): Promise<MediaCall | null> {
  return must(await db().from('calls').select(MEDIA_COLUMNS).eq('id', callId).maybeSingle()) as MediaCall | null;
}

/**
 * Copies a finished Twilio recording into Supabase Storage, then starts a transcript (or skips it for voicemails
 * we reached / no-answers). Safe to call repeatedly: each step only runs once. Called from the recording webhook,
 * and again by the sweep / on playback if that didn't finish.
 */
export async function processRecording(call: MediaCall): Promise<void> {
  if (!call.recording_sid) return;

  if (!call.recording_path) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env('TWILIO_ACCOUNT_SID')}/Recordings/${call.recording_sid}.mp3`, {
      headers: { Authorization: twilioAuthHeader() },
    });
    if (!res.ok) throw new Error(`Twilio recording ${call.recording_sid} download failed: ${res.status}`);
    const path = `${call.id}.mp3`;
    const { error } = await db().storage.from(RECORDINGS_BUCKET).upload(path, await res.arrayBuffer(), { contentType: 'audio/mpeg', upsert: true });
    if (error) throw new Error(`Recording upload failed: ${error.message}`);
    must(await db().from('calls').update({ recording_path: path }).eq('id', call.id));
    call.recording_path = path;
  }

  if (call.transcript_status) return;

  const serviceSid = process.env.TWILIO_INTELLIGENCE_SERVICE_SID;
  const duration = call.recording_duration_s ?? call.duration_s;
  if (!serviceSid || !shouldTranscribe({ kind: call.kind, answeredBy: call.answered_by, durationS: duration })) {
    must(await db().from('calls').update({ transcript_status: 'skipped' }).eq('id', call.id));
    await deleteTwilioRecording(call.recording_sid);
    return;
  }

  const transcript = await twilioClient().intelligence.v2.transcripts.create({
    serviceSid,
    channel: { media_properties: { source_sid: call.recording_sid } },
    customerKey: call.id,
  });
  must(await db().from('calls').update({ transcript_sid: transcript.sid, transcript_status: 'pending' }).eq('id', call.id));
}

/**
 * Fetches a finished transcript from Twilio and saves it on the call. Returns false while Twilio is still working.
 * Once saved, the Twilio copies of the recording and transcript are deleted (ours live in Supabase).
 */
export async function storeTranscript(call: MediaCall): Promise<boolean> {
  if (!call.transcript_sid || call.transcript_status !== 'pending') return true;
  const client = twilioClient();
  const t = await client.intelligence.v2.transcripts(call.transcript_sid).fetch();

  if (t.status === 'queued' || t.status === 'in-progress') return false;
  if (t.status !== 'completed') {
    must(await db().from('calls').update({ transcript_status: 'failed' }).eq('id', call.id));
    return true;
  }

  const sentences = await client.intelligence.v2.transcripts(call.transcript_sid).sentences.list({ limit: 5000 });
  const speaker = (channel: number) =>
    call.kind === 'voicemail' ? 'Caller' : channel === 1 ? call.agent_name || 'Rep' : call.full_name || 'Prospect';
  const turns: TranscriptTurn[] = [];
  for (const s of sentences.sort((a, b) => a.sentenceIndex - b.sentenceIndex)) {
    const name = speaker(s.mediaChannel);
    const start = Number.parseFloat(s.startTime);
    const last = turns[turns.length - 1];
    // Merge consecutive sentences from the same speaker into one turn.
    if (last && last.speaker === name) last.text += ` ${s.transcript}`;
    else turns.push({ speaker: name, text: s.transcript, start: Number.isFinite(start) ? start : null });
  }

  must(
    await db()
      .from('calls')
      .update({
        transcript_status: 'completed',
        transcript: turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
        transcript_json: turns,
      })
      .eq('id', call.id),
  );

  await deleteTwilioRecording(call.recording_sid);
  await client.intelligence.v2
    .transcripts(call.transcript_sid)
    .remove()
    .catch((err) => console.warn('Could not delete Twilio transcript', call.transcript_sid, err));
  return true;
}

async function deleteTwilioRecording(sid: string | null) {
  if (!sid) return;
  await twilioClient()
    .recordings(sid)
    .remove()
    .catch((err) => console.warn('Could not delete Twilio recording', sid, err));
}

/** Short-lived link to play a recording. */
export async function signedRecordingUrl(path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await db().storage.from(RECORDINGS_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error) console.error('Could not sign recording', path, error.message);
  return data?.signedUrl ?? null;
}
