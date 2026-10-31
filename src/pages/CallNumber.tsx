import { Phone, PhoneCall } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatPhone, normalizeCallable } from '../../shared/phone';
import type { Campaign, Contact } from '../../shared/types';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/States';
import { useVoice } from '../voice/VoiceProvider';

/**
 * Admin click-to-call: one-off calls to any AU/NZ number, outside campaigns. MaronlyOS's CRM call button links here
 * with the lead's details, e.g. /call?to=0412345678&name=Jane%20Doe&company=Acme&client=Kintell, and the call goes
 * out from the number chosen as the click-to-call number in Phone numbers. The call bar and wrap-up are the same as
 * any other call, and the call is logged in Call logs as "Click-to-call".
 */
export default function CallNumber() {
  const [params] = useSearchParams();
  const { dial, active, deviceState } = useVoice();
  const [number, setNumber] = useState(params.get('to') ?? '');
  const [name, setName] = useState(params.get('name') ?? '');
  const company = params.get('company') ?? '';
  const client = params.get('client') ?? '';
  const [error, setError] = useState<string | null>(null);
  const phone = useMemo(() => normalizeCallable(number), [number]);

  const call = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!phone.ok) return setError(phone.reason);
    setError(null);
    // Stand-ins: one-off calls have no contact or campaign rows; VoiceProvider sends the number itself.
    const contact = {
      id: '',
      campaign_id: '',
      airtable_client_id: null,
      client_name: client || null,
      full_name: name.trim() || null,
      first_name: name.trim().split(/\s+/)[0] || null,
      company: company || null,
      title: null,
      email: null,
      phone_e164: phone.e164,
      phone_raw: number,
      linkedin: null,
      website: null,
      custom: {},
      status: 'new',
      callback_user_id: null,
      attempts: 0,
      last_called_at: null,
      next_attempt_at: null,
      last_disposition: null,
      locked_by: null,
      locked_at: null,
      airtable_lead_id: null,
      created_at: new Date().toISOString(),
    } satisfies Contact;
    const campaign = { id: '', name: 'Click-to-call', client_name: client, airtable_client_id: '', caller_number_id: null, script_id: null, status: 'active', created_at: contact.created_at } satisfies Campaign;
    try {
      await dial(contact, campaign, 'oneoff');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the call.');
    }
  };

  return (
    <>
      <PageHeader title="Click-to-call" subtitle="One-off calls to any Australian or New Zealand number, outside campaigns. Logged in Call logs." />
      <section className="card mx-auto max-w-xl animate-appear p-6 sm:p-8">
        <form onSubmit={call} className="space-y-4">
          <div>
            <label htmlFor="ctc-number" className="mb-2 block text-sm font-medium text-ink-soft">
              Number
            </label>
            <input id="ctc-number" type="tel" className="field text-lg tabular-nums" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="0412 345 678" autoFocus={!number} />
            {number && <p className={`mt-1.5 text-xs ${phone.ok ? 'text-ink-muted' : 'text-red-600'}`}>{phone.ok ? `Calls ${formatPhone(phone.e164)}` : phone.reason}</p>}
          </div>
          <div>
            <label htmlFor="ctc-name" className="mb-2 block text-sm font-medium text-ink-soft">
              Name <span className="font-normal text-ink-faint">(optional, for the call log)</span>
            </label>
            <input id="ctc-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {(company || client) && <p className="text-sm text-ink-muted">{[company, client && `for ${client}`].filter(Boolean).join(' ')}</p>}
          {error && (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </p>
          )}
          <Button type="submit" size="md" className="w-full" disabled={!phone.ok || !!active || deviceState === 'starting'}>
            {active ? <PhoneCall size={18} /> : <Phone size={18} />} {active ? 'On a call' : `Call ${phone.ok ? formatPhone(phone.e164) : ''}`}
          </Button>
        </form>
      </section>
    </>
  );
}
