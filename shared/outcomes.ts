import type { ContactStatus, Disposition } from './constants';

/**
 * A contact's status after a wrap-up. Every call takes the contact out of the queue; an admin can put contacts back
 * by disposition (Re-run on Manage campaigns). Do Not Call also blocks the number in every other campaign.
 */
export function contactOutcome(disposition: Disposition): ContactStatus {
  switch (disposition) {
    case 'Do Not Call':
      return 'do_not_call';
    case 'Wrong Number':
    case 'Disconnected Number':
      return 'bad_number';
    default:
      return 'done';
  }
}
