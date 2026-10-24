import type { ContactStatus, Disposition } from './constants';

/**
 * A contact's status after a wrap-up. Every call takes the contact out of the queue, except Callback, which keeps it
 * for the rep who booked it until the callback time. An admin can re-run contacts by disposition into a new
 * campaign. Do Not Call also blocks the number in every other campaign.
 */
export function contactOutcome(disposition: Disposition): ContactStatus {
  switch (disposition) {
    case 'Callback':
      return 'callback';
    case 'Do Not Call':
      return 'do_not_call';
    case 'Wrong Number':
    case 'Disconnected Number':
      return 'bad_number';
    default:
      return 'done';
  }
}
