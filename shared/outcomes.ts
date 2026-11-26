import type { ContactStatus, Disposition, PickupStatus } from './constants';

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

/** Outcomes that can only come from talking to someone: the pickup is a person, whatever Twilio's detection guessed. */
const TALKED: readonly Disposition[] = ['Interested - Appointment Set', 'Interested - Needs Follow-Up', 'Referral', 'Not Interested', 'Unqualified Lead'];

/**
 * The pickup to save: Twilio's answering-machine detection sometimes calls a person a machine. If the rep hasn't set
 * the pickup themselves and the outcome means they spoke to someone, it's a Human Pickup.
 */
export function pickupFor(disposition: Disposition | '' | null, pickup: PickupStatus | '', repChosePickup: boolean): PickupStatus | '' {
  if (repChosePickup || !disposition || !TALKED.includes(disposition)) return pickup;
  return 'Human Pickup';
}
