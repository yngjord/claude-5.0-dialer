import type { Contact } from '../../shared/types';

const LOCK_MS = 30 * 60_000;

/** A teammate's power dialer currently has this contact (same rule as claim_next_contact). */
export function lockedByTeammate(contact: Contact, myId: string | undefined): boolean {
  return !!contact.locked_by && contact.locked_by !== myId && !!contact.locked_at && Date.now() - new Date(contact.locked_at).getTime() < LOCK_MS;
}
