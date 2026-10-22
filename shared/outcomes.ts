import type { ContactStatus, Disposition } from './constants';

export interface ContactOutcome {
  status: ContactStatus;
  /** When the contact comes back into the queue; null = never. */
  nextAttemptAt: Date | null;
}

/**
 * What happens to a contact after a wrap-up.
 * No Answer / Left Voicemail go back in the queue after the campaign's retry delay until `maxAttempts` dials have
 * been made; everything else takes the contact out of the queue.
 */
export function contactOutcome(
  disposition: Disposition,
  opts: { attemptsAfterThisCall: number; maxAttempts: number; retryAfterMinutes: number; now?: Date },
): ContactOutcome {
  const now = opts.now ?? new Date();
  switch (disposition) {
    case 'No Answer':
    case 'Left Voicemail':
      if (opts.attemptsAfterThisCall >= opts.maxAttempts) return { status: 'done', nextAttemptAt: null };
      return { status: 'callback', nextAttemptAt: new Date(now.getTime() + opts.retryAfterMinutes * 60_000) };
    case 'Do Not Call':
      return { status: 'do_not_call', nextAttemptAt: null };
    case 'Wrong Number':
    case 'Disconnected Number':
      return { status: 'bad_number', nextAttemptAt: null };
    default:
      return { status: 'done', nextAttemptAt: null };
  }
}
