import { useMemo, useState, type FormEvent } from 'react';
import { validateManualBooking, type ManualBookingInput } from '../../shared/leads';
import type { AirtableClient, Campaign, NewBookingResponse } from '../../shared/types';
import { api, must, useLoad } from '../lib/api';
import { timeBookedText, ZONES } from '../lib/bookingTime';
import { supabase } from '../lib/supabase';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

const Label = ({ htmlFor, children, required = false }: { htmlFor: string; children: React.ReactNode; required?: boolean }) => (
  <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-ink-soft">
    {children} {required && <span className="text-red-600">*</span>}
  </label>
);

/**
 * Adds a booking by hand, replacing the Airtable "New Booking" form while calls move over from JustCall. Always
 * Stage = Booking and Channel = Cold Call; the time is picked with a zone and saved as text, e.g. "2:30pm AEDT".
 */
export function NewLeadModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const clients = useLoad(() => api<AirtableClient[]>('clients'), []);
  const campaigns = useLoad(async () => must(await supabase.from('dialer_campaigns').select('name, airtable_client_id').order('name')) as Pick<Campaign, 'name' | 'airtable_client_id'>[], []);
  const [clientId, setClientId] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [bookedFor, setBookedFor] = useState('');
  const [time, setTime] = useState('');
  const [tz, setTz] = useState('Australia/Sydney');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suggest this client's dialer campaign names; any name can still be typed.
  const suggestions = useMemo(() => [...new Set((campaigns.data ?? []).filter((c) => c.airtable_client_id === clientId).map((c) => c.name))], [campaigns.data, clientId]);
  const timeText = timeBookedText(bookedFor, time, tz);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const body: ManualBookingInput = {
      airtableClientId: clientId,
      campaignName,
      linkedin,
      lead: { fullName, email, phone, notes, bookedFor: bookedFor || null, timeBookedFor: timeText || null },
    };
    const problems = validateManualBooking(body);
    if (problems.length) return setError(problems.join(' '));
    setSaving(true);
    setError(null);
    try {
      await api<NewBookingResponse>('leads', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the lead.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add new lead"
      size="lg"
      onClose={saving ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="new-lead" disabled={saving}>
            {saving && <Spinner />} Add lead
          </Button>
        </>
      }
    >
      <form id="new-lead" onSubmit={submit} autoComplete="off" noValidate className="space-y-4">
        <p className="text-sm text-ink-muted">
          A booked meeting from a cold call. It's saved to Airtable at the <b className="font-medium text-ink-soft">Booking</b> stage, channel{' '}
          <b className="font-medium text-ink-soft">Cold Call</b>, attributed to you.
        </p>
        <div>
          <Label htmlFor="nl-client" required>
            Client
          </Label>
          <select id="nl-client" className="field" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!clients.data}>
            <option value="">{clients.loading ? 'Loading clients…' : clients.error ? "Couldn't load clients" : 'Choose a client'}</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="nl-campaign" required>
            Campaign name
          </Label>
          <input id="nl-campaign" list="nl-campaigns" maxLength={200} className="field" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
          <datalist id="nl-campaigns">
            {suggestions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor="nl-name" required>
            Prospect full name
          </Label>
          <input id="nl-name" maxLength={200} className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="nl-email" required>
              Prospect email
            </Label>
            <input id="nl-email" type="email" maxLength={320} className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nl-phone" required>
              Phone number
            </Label>
            <input id="nl-phone" type="tel" maxLength={50} className="field" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="nl-linkedin" required>
            LinkedIn profile
          </Label>
          <input id="nl-linkedin" type="url" maxLength={500} className="field" placeholder="https://linkedin.com/in/…" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
          <div>
            <Label htmlFor="nl-date" required>
              Date booked for
            </Label>
            <input id="nl-date" type="date" className="field" value={bookedFor} onChange={(e) => setBookedFor(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nl-time" required>
              Time booked for
            </Label>
            <div className="flex gap-2">
              <input id="nl-time" type="time" className="field" value={time} onChange={(e) => setTime(e.target.value)} />
              <select aria-label="Time zone" className="field !w-auto" value={tz} onChange={(e) => setTz(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z.tz} value={z.tz}>
                    {z.label}
                  </option>
                ))}
              </select>
            </div>
            {timeText && <p className="mt-1.5 text-xs text-ink-muted">Saved as “{timeText}”</p>}
          </div>
        </div>
        <div>
          <Label htmlFor="nl-notes">Booking notes</Label>
          <textarea id="nl-notes" rows={4} maxLength={5000} className="field resize-y" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
