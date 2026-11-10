// Pickup Status itself is worked out in Postgres (pickup_status_from() in the migration), so Twilio's status and
// AMD callbacks can't overwrite each other when they arrive at the same moment.

/**
 * Calls worth transcribing: anything that might have been a conversation, skipping clear voicemails and no-answers.
 * A rep's Human Pickup overrides Twilio's answering-machine guess (it's sometimes wrong).
 */
export function shouldTranscribe(opts: { kind: 'call' | 'voicemail'; answeredBy: string | null; durationS: number | null; pickupStatus?: string | null }): boolean {
  if (opts.kind === 'voicemail') return (opts.durationS ?? 0) >= 2;
  if (opts.pickupStatus === 'Human Pickup') return (opts.durationS ?? 0) >= 2;
  if (opts.answeredBy && (opts.answeredBy.startsWith('machine') || opts.answeredBy === 'fax')) return false;
  return (opts.durationS ?? 0) >= 5;
}
