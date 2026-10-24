import type { ActiveCall } from './VoiceProvider';

/** What the line is doing, preferring Twilio's view (webhooks) over the browser's. */
export function callStatusLabel(call: ActiveCall): { label: string; tone: 'muted' | 'live' | 'warn' } {
  const { row, phase } = call;
  if (phase === 'ended') return { label: call.error ?? 'Call ended', tone: call.error ? 'warn' : 'muted' };
  if (row?.answered_by && (row.answered_by.startsWith('machine') || row.answered_by === 'fax')) return { label: 'Voicemail detected', tone: 'warn' };
  // The SDK's accept (answerOnBridge: fires on answer) usually beats the webhook; either one means connected.
  if (row?.twilio_status === 'in-progress' || row?.answered_at || phase === 'live') return { label: 'Connected', tone: 'live' };
  // Only Twilio's webhook says the phone itself is ringing; the SDK's own "ringing" fires as soon as the call is placed.
  if (row?.twilio_status === 'ringing') return { label: 'Ringing…', tone: 'muted' };
  return { label: 'Connecting…', tone: 'muted' };
}
