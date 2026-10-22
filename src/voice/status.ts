import type { ActiveCall } from './VoiceProvider';

/** What the line is doing, preferring Twilio's view (webhooks) over the browser's. */
export function callStatusLabel(call: ActiveCall): { label: string; tone: 'muted' | 'live' | 'warn' } {
  const { row, phase } = call;
  if (phase === 'ended') return { label: call.error ?? 'Call ended', tone: call.error ? 'warn' : 'muted' };
  if (row?.answered_by && (row.answered_by.startsWith('machine') || row.answered_by === 'fax')) return { label: 'Voicemail detected', tone: 'warn' };
  if (row?.twilio_status === 'in-progress' || row?.answered_at) return { label: 'Connected', tone: 'live' };
  if (row?.twilio_status === 'ringing' || phase === 'ringing') return { label: 'Ringing…', tone: 'muted' };
  return { label: 'Connecting…', tone: 'muted' };
}
