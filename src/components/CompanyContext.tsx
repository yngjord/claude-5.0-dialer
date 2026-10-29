import { Users } from 'lucide-react';
import type { Contact } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';

interface PastCall {
  started_at: string;
  agent_name: string | null;
  full_name: string | null;
  title: string | null;
  disposition: string | null;
  notes: string | null;
}

/**
 * Heads-up before dialing: someone else at this contact's company has already spoken to us for this client (a
 * human pickup, any rep or campaign), with what was noted. Teal, so it reads apart from the purple callback panel.
 * Shows nothing when there's no such call.
 */
export function CompanyContext({ contact }: { contact: Contact }) {
  const history = useLoad(async () => must(await supabase.rpc('dialer_company_history', { p_contact_id: contact.id })) as PastCall[], [contact.id]);
  const calls = history.data ?? [];
  if (!calls.length) return null;

  return (
    <div className="mx-auto mb-6 max-w-xl rounded-2xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-left text-sm">
      <p className="flex items-center gap-2 font-medium text-teal-900">
        <Users size={16} /> We've spoken to {calls.length === 1 ? 'someone' : `${calls.length} people`} at {contact.company || 'this company'} before
      </p>
      <ul className="mt-2 space-y-2.5">
        {calls.map((c) => (
          <li key={c.started_at}>
            <p className="text-xs text-teal-900/70">
              {[c.full_name, c.title].filter(Boolean).join(', ') || 'Someone'} · {formatDateTime(c.started_at)}
              {c.agent_name ? ` · ${c.agent_name}` : ''}
              {c.disposition ? ` · ${c.disposition}` : ''}
            </p>
            <p className="whitespace-pre-wrap text-ink-soft">{c.notes || 'No notes were left on that call.'}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
