import { Building2, ExternalLink, Mail, MessageSquare, Phone } from 'lucide-react';
import { useState } from 'react';
import { formatPhone } from '../../shared/phone';
import type { CallRow, Contact } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import { domainOf, formatDateTime, withProtocol } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES, PICKUP_TONES } from '../lib/tones';
import { SmsThreadModal } from './SmsThread';
import { Badge } from './ui/Badge';

/** Everything the rep needs on screen while dialing: who it is, links, custom fields and past calls to this number. */
export function ContactCard({ contact }: { contact: Contact }) {
  const [sms, setSms] = useState(false);
  const history = useLoad(
    async () =>
      must(
        await supabase
          .from('calls')
          .select('id, started_at, agent_name, pickup_status, disposition, notes, campaign_name')
          .eq('phone_e164', contact.phone_e164)
          .order('started_at', { ascending: false })
          .limit(6),
      ) as Pick<CallRow, 'id' | 'started_at' | 'agent_name' | 'pickup_status' | 'disposition' | 'notes' | 'campaign_name'>[],
    [contact.phone_e164],
  );
  const custom = Object.entries(contact.custom ?? {});

  return (
    <div>
      <h2 className="font-display text-[26px] font-normal leading-tight sm:text-[30px]">{contact.full_name || 'Unknown name'}</h2>
      {(contact.title || contact.company) && (
        <p className="mt-1 flex items-center gap-2 text-ink-muted">
          <Building2 size={15} className="shrink-0" />
          {[contact.title, contact.company].filter(Boolean).join(' at ')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 font-medium tabular-nums">
          <Phone size={14} /> {formatPhone(contact.phone_e164)}
        </span>
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 hover:text-brand">
            <Mail size={14} /> {contact.email}
          </a>
        )}
        {contact.linkedin && (
          <a href={withProtocol(contact.linkedin)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint px-3 py-1.5 text-brand hover:bg-brand hover:text-white">
            <span className="text-[11px] font-semibold">in</span> LinkedIn
          </a>
        )}
        {contact.website && (
          <a href={withProtocol(contact.website)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 hover:text-brand">
            {domainOf(contact.website)} <ExternalLink size={12} />
          </a>
        )}
        <button onClick={() => setSms(true)} className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 hover:border-brand hover:text-brand">
          <MessageSquare size={14} /> Text
        </button>
      </div>

      {custom.length > 0 && (
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {custom.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-ink-faint">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-6">
        <h3 className="mb-2 font-display text-[13px] font-medium text-ink-muted">
          Previous calls {contact.attempts > 0 && <span className="text-ink-faint">· {contact.attempts} in this campaign</span>}
        </h3>
        {history.loading ? (
          <div className="skeleton h-10 w-full" />
        ) : !history.data?.length ? (
          <p className="text-sm text-ink-faint">First time calling this number.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line text-sm">
            {history.data.map((c) => (
              <li key={c.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums text-ink-muted">{formatDateTime(c.started_at)}</span>
                  {c.agent_name && <span className="text-ink-faint">· {c.agent_name}</span>}
                  {c.pickup_status && <Badge tone={PICKUP_TONES[c.pickup_status] ?? 'grey'}>{c.pickup_status}</Badge>}
                  {c.disposition && <Badge tone={DISPOSITION_TONES[c.disposition] ?? 'grey'}>{c.disposition}</Badge>}
                </div>
                {c.notes && <p className="mt-1 text-ink-soft">{c.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {sms && <SmsThreadModal phone={contact.phone_e164} contactId={contact.id} title={contact.full_name || formatPhone(contact.phone_e164)} onClose={() => setSms(false)} />}
    </div>
  );
}
