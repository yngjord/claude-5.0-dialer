import type { Disposition } from '../../shared/constants';
import type { CallRow, Campaign, Contact } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import type { ActiveCall } from '../voice/VoiceProvider';
import { Modal } from './ui/Modal';
import { ErrorState, LoadingRows } from './ui/States';
import { WrapUpForm, type WrapUpResult } from './WrapUpForm';
import { supabase } from '../lib/supabase';

/**
 * Power dialer: reopen the wrap-up of the call just saved, to fix a misclick (pickup status, disposition, notes or
 * callback time). Saves through the same wrap-up as before, so a lead is never made twice and a contact that's been
 * called again since isn't moved back.
 */
export function EditLastCallModal({
  callId,
  campaign,
  onClose,
  onSaved,
}: {
  callId: string;
  campaign: Campaign;
  onClose: () => void;
  onSaved: (before: Pick<CallRow, 'pickup_status' | 'disposition'>, after: WrapUpResult) => void;
}) {
  const data = useLoad(async () => {
    const row = must(await supabase.from('dialer_calls').select('*').eq('id', callId).single()) as CallRow;
    const contact = row.contact_id ? (must(await supabase.from('dialer_contacts').select('*').eq('id', row.contact_id).maybeSingle()) as Contact | null) : null;
    return { row, contact };
  }, [callId]);

  const row = data.data?.row;
  const contact = data.data?.contact;
  const call: ActiveCall | null =
    row && contact ? { callId, contact, campaign, mode: 'power', phase: 'ended', muted: false, answeredAt: null, row, error: null } : null;

  return (
    <Modal title={`Edit last call${contact?.full_name ? `: ${contact.full_name}` : ''}`} size="lg" onClose={onClose}>
      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !call || !row ? (
        data.loading ? (
          <LoadingRows label="Loading the call…" />
        ) : (
          <p className="text-sm text-ink-muted">This call's contact has been removed, so it can't be edited here.</p>
        )
      ) : (
        <WrapUpForm
          call={call}
          saved={{
            disposition: (row.disposition as Disposition | null) ?? null,
            notes: row.notes,
            callbackAt: row.disposition === 'Callback' ? call.contact.next_attempt_at : null,
            leadCreated: !!row.airtable_lead_id,
          }}
          onDone={(result) => onSaved({ pickup_status: row.pickup_status, disposition: row.disposition }, result)}
        />
      )}
    </Modal>
  );
}
