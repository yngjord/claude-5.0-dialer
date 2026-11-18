import { Sparkles } from 'lucide-react';
import type { Contact } from '../../shared/types';

/**
 * Evergreen leads: the client's note on why this person is warm (from the portal), to open the call with. Amber, so
 * it reads apart from the teal "spoken to someone at this company" panel when both show.
 */
export function LeadContext({ contact, clientName }: { contact: Contact; clientName: string | null | undefined }) {
  const context = contact.context?.trim();
  if (!context) return null;
  return (
    <div className="mx-auto mb-6 max-w-xl rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-left text-sm">
      <p className="flex items-center gap-2 font-medium text-amber-900">
        <Sparkles size={16} /> Warm lead from {clientName || 'the client'}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-ink-soft">{context}</p>
    </div>
  );
}
