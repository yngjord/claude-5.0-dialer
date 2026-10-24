import { AlertTriangle, CheckCircle2, Phone } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { APPOINTMENT_SET, DISPOSITIONS, LEAD_DISPOSITIONS, PICKUP_STATUSES, type Disposition, type PickupStatus } from '../../shared/constants';
import { validateLead } from '../../shared/leads';
import type { WrapUpRequest, WrapUpResponse } from '../../shared/types';
import { api } from '../lib/api';
import type { ActiveCall } from '../voice/VoiceProvider';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

const ZONES = [
  { tz: 'Australia/Sydney', locale: 'en-AU', label: 'Sydney / Melbourne' },
  { tz: 'Australia/Brisbane', locale: 'en-AU', label: 'Brisbane' },
  { tz: 'Australia/Adelaide', locale: 'en-AU', label: 'Adelaide' },
  { tz: 'Australia/Perth', locale: 'en-AU', label: 'Perth' },
  { tz: 'Pacific/Auckland', locale: 'en-NZ', label: 'New Zealand' },
];

/** "2026-10-30", "14:30", Sydney → "2:30pm AEDT" (the zone abbreviation for that date, so DST is right). */
function timeBookedText(date: string, time: string, tz: string): string {
  if (!time) return '';
  const zone = ZONES.find((z) => z.tz === tz) ?? ZONES[0];
  const [h, m] = time.split(':').map(Number);
  const hour12 = h % 12 || 12;
  const at = new Date(`${date || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const abbr = new Intl.DateTimeFormat(zone.locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${hour12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'} ${abbr}`.trim();
}

/** Disposition that fits the pickup when the rep hasn't picked one: saves a click on the many unanswered dials. */
function suggestedDisposition(pickup: PickupStatus | null): Disposition | null {
  if (pickup === 'Unanswered' || pickup === 'Busy' || pickup === 'Failed') return 'No Answer';
  return null;
}

export interface WrapUpResult {
  disposition: Disposition;
  pickup: PickupStatus;
  /** "Save & dial next" was pressed: call the next contact straight away. */
  dialNext: boolean;
}

/**
 * Post-call form. With `dialNextOption` (power dialer) it has two buttons: "Save & dial next", and "Save" which moves
 * on to the next contact and dials it per the auto-dial setting.
 */
export function WrapUpForm({ call, onDone, dialNextOption = false }: { call: ActiveCall; onDone: (result: WrapUpResult) => void; dialNextOption?: boolean }) {
  const livePickup = call.row?.pickup_status ?? null;
  const [pickup, setPickup] = useState<PickupStatus | ''>(livePickup ?? '');
  const [pickupTouched, setPickupTouched] = useState(false);
  const [disposition, setDisposition] = useState<Disposition | ''>(suggestedDisposition(livePickup) ?? '');
  const [dispositionTouched, setDispositionTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [fullName, setFullName] = useState(call.contact.full_name ?? '');
  const [email, setEmail] = useState(call.contact.email ?? '');
  const [phone, setPhone] = useState(call.contact.phone_e164);
  const [bookedFor, setBookedFor] = useState('');
  const [time, setTime] = useState('');
  const [tz, setTz] = useState(call.contact.phone_e164.startsWith('+64') ? 'Pacific/Auckland' : 'Australia/Sydney');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [dialNext, setDialNext] = useState(false);

  // Twilio's result can land a second or two after hang-up: keep following it until the rep changes it.
  useEffect(() => {
    if (!pickupTouched && livePickup) setPickup(livePickup);
    if (!dispositionTouched && livePickup) setDisposition((d) => d || suggestedDisposition(livePickup) || '');
  }, [livePickup, pickupTouched, dispositionTouched]);

  const needsLead = !!disposition && LEAD_DISPOSITIONS.includes(disposition);
  const lead = useMemo(
    () => ({
      fullName,
      email,
      phone,
      notes,
      bookedFor: disposition === APPOINTMENT_SET ? bookedFor || null : null,
      timeBookedFor: disposition === APPOINTMENT_SET ? timeBookedText(bookedFor, time, tz) : null,
    }),
    [fullName, email, phone, notes, disposition, bookedFor, time, tz],
  );

  const submit = async (e?: FormEvent, next = dialNext) => {
    e?.preventDefault();
    setDialNext(next);
    if (submitting || call.phase !== 'ended') return;
    if (!pickup) return setError('Choose a pickup status.');
    if (!disposition) return setError('Choose a disposition.');
    if (needsLead) {
      const problems = validateLead(disposition, lead);
      if (problems.length) return setError(problems.join(' '));
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: WrapUpRequest = { callId: call.callId, pickupStatus: pickup, disposition, notes, ...(needsLead ? { lead } : {}) };
      const res = await api<WrapUpResponse>('wrap-up', { method: 'POST', body: JSON.stringify(body) });
      if (res.leadError) {
        setLeadError(res.leadError);
        setSubmitting(false);
        return;
      }
      onDone({ disposition, pickup, dialNext: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setSubmitting(false);
    }
  };

  // Keyboard: Enter saves (Ctrl/⌘+Enter inside the notes box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if (e.key === 'Enter' && (!typing || e.metaKey || e.ctrlKey) && target.tagName !== 'BUTTON') {
        e.preventDefault();
        submit(undefined, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="pickup" className="mb-2 block text-sm font-medium text-ink-soft">
          Pickup status
        </label>
        <select
          id="pickup"
          className="field"
          value={pickup}
          onChange={(e) => {
            setPickup(e.target.value as PickupStatus);
            setPickupTouched(true);
          }}
        >
          {!pickup && <option value="">{call.phase === 'ended' && !livePickup ? 'Waiting for Twilio…' : 'Choose…'}</option>}
          {PICKUP_STATUSES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="disposition" className="mb-2 block text-sm font-medium text-ink-soft">
          Disposition
        </label>
        <select
          id="disposition"
          className="field"
          value={disposition}
          onChange={(e) => {
            setDisposition(e.target.value as Disposition);
            setDispositionTouched(true);
          }}
        >
          {!disposition && <option value="">Choose…</option>}
          {DISPOSITIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {needsLead && (
        <div className="space-y-4 rounded-card border-2 border-brand/20 bg-brand-tint/50 p-4 sm:p-5">
          <p className="flex items-center gap-2 font-display text-[15px] font-medium text-brand">
            <CheckCircle2 size={18} /> Creates a new lead inside the CRM
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lead-name" label="Prospect full name" value={fullName} onChange={setFullName} required />
            <Field id="lead-email" label="Email address" type="email" value={email} onChange={setEmail} />
            <Field id="lead-phone" label="Phone number" type="tel" value={phone} onChange={setPhone} />
            {disposition === APPOINTMENT_SET && (
              <>
                <Field id="lead-booked-for" label="Booked for" type="date" value={bookedFor} onChange={setBookedFor} required />
                <div>
                  <label htmlFor="lead-time" className="mb-2 block text-sm font-medium text-ink-soft">
                    Time booked for <span className="text-red-600">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input id="lead-time" type="time" className="field" value={time} onChange={(e) => setTime(e.target.value)} />
                    <select aria-label="Time zone" className="field !w-auto" value={tz} onChange={(e) => setTz(e.target.value)}>
                      {ZONES.map((z) => (
                        <option key={z.tz} value={z.tz}>
                          {z.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {time && <p className="mt-1.5 text-xs text-ink-muted">Saved as “{timeBookedText(bookedFor, time, tz)}”</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="notes" className="mb-2 block text-sm font-medium text-ink-soft">
          Notes {needsLead && <span className="font-normal text-ink-faint">(saved to the lead's notes)</span>}
        </label>
        <textarea id="notes" rows={3} className="field resize-y" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened on the call?" />
      </div>

      {error && (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {leadError && (
        <div role="alert" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle size={16} /> The call was saved, but the lead couldn't be created in the CRM.
          </p>
          <p className="mt-1 text-amber-800">{leadError}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => submit()} disabled={submitting}>
              Retry Lead
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDone({ disposition: disposition as Disposition, pickup: pickup as PickupStatus, dialNext })}>
              Continue without it
            </Button>
          </div>
        </div>
      )}

      {!leadError &&
        (call.phase !== 'ended' ? (
          <Button type="button" size="md" className="w-full" disabled>
            Hang up to save
          </Button>
        ) : dialNextOption ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" size="md" variant="outline" disabled={submitting} onClick={() => submit(undefined, false)}>
              {submitting && !dialNext ? <Spinner /> : null} Save
            </Button>
            <Button type="button" size="md" disabled={submitting} onClick={() => submit(undefined, true)}>
              {submitting && dialNext ? <Spinner /> : <Phone size={17} />} Save &amp; dial next
            </Button>
          </div>
        ) : (
          <Button type="submit" size="md" className="w-full" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner /> Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        ))}
    </form>
  );
}

function Field({ id, label, value, onChange, type = 'text', required }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink-soft">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      <input id={id} type={type} className="field" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
