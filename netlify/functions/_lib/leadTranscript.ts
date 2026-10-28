import { LEAD_FIELDS, leadTranscriptText } from '../../../shared/leads';
import type { TranscriptTurn } from '../../../shared/types';
import { updateRecord } from './airtable';
import { db, must } from './db';

/**
 * Writes a call's transcript to the Airtable lead it created (Leads → Cold Call Transcript), once per call
 * (dialer_calls.transcript_synced_at). The transcript usually lands a minute or two after the lead is created, so
 * this runs from both ends: when the transcript is saved, and after a wrap-up creates the lead. The sweep retries.
 */
export async function syncLeadTranscript(callId: string): Promise<void> {
  const call = must(
    await db().from('dialer_calls').select('airtable_lead_id, transcript_status, transcript, transcript_json, transcript_synced_at').eq('id', callId).maybeSingle(),
  ) as {
    airtable_lead_id: string | null;
    transcript_status: string | null;
    transcript: string | null;
    transcript_json: TranscriptTurn[] | null;
    transcript_synced_at: string | null;
  } | null;
  if (!call?.airtable_lead_id || call.transcript_status !== 'completed' || call.transcript_synced_at) return;

  const text = leadTranscriptText(call.transcript_json, call.transcript);
  if (text) await updateRecord('Leads', call.airtable_lead_id, { [LEAD_FIELDS.transcript]: text });
  must(await db().from('dialer_calls').update({ transcript_synced_at: new Date().toISOString() }).eq('id', callId));
}
