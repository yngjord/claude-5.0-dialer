import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { APPOINTMENT_SET, DISPOSITIONS, LEAD_DISPOSITIONS, NEEDS_FOLLOW_UP, PICKUP_STATUSES, type Disposition, type PickupStatus } from '../../shared/constants';
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

export function WrapUpForm({ call, onDone }: { call: ActiveCall; onDone: (result: { disposition: Disposition; pickup: PickupStatus }) => void }) {
  const livePickup = call.row?.pickup_status ?? null;
  const [pickup, setPickup] = useState<PickupStatus | ''>(livePickup ?? '');
  const [pickupTouched, setPickupTouched] = useState(false);
  const [disposition, setDisposition] = useState<Disposition | ''>(suggestedDisposition(livePickup) ?? '');
  const [dispositionTouched, setDispositionTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [fullName, setFullName] = useState(call.contact.full_name ?? '');
  const [email, setEmail] = useState(call.contact.email ?? '');
  const [phone, setPhone] = useState(call.contact.phone_e164);
  const [nextFollowUp, setNextFollowUp] = useState('');
  const [bookedFor, setBookedFor] = useState('');
  const [time, setTime] = useState('');
  const [tz, setTz] = useState(call.contact.phone_e164.startsWith('+64') ? 'Pacific/Auckland' : 'Australia/Sydney');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);

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
      nextFollowUp: disposition === NEEDS_FOLLOW_UP ? nextFollowUp || null : null,
      bookedFor: disposition === APPOINTMENT_SET ? bookedFor || null : null,
      timeBookedFor: disposition === APPOINTMENT_SET ? timeBookedText(bookedFor, time, tz) : null,
    }),
    [fullName, email, phone, notes, disposition, nextFollowUp, bookedFor, time, tz],
  );

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
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
      onDone({ disposition, pickup });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setSubmitting(false);
    }
  };

  // Keyboard: 1–9 picks a disposition, Enter saves (Ctrl/⌘+Enter inside the notes box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if (!typing && /^[1-9]$/.test(e.key)) {
        const d = DISPOSITIONS[Number(e.key) - 1];
        if (d) {
          setDisposition(d);
          setDispositionTouched(true);
        }
      }
      if (e.key === 'Enter' && (!typing || e.metaKey || e.ctrlKey) && target.tagName !== 'BUTTON') {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="pickup" className="mb-2 block text-sm font-medium text-ink-soft">
          Pickup status {!pickupTouched && livePickup && <span className="font-normal text-ink-faint">(from Twilio)</span>}
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

      <fieldset>
        <legend className="mb-2 block text-sm font-medium text-ink-soft">Disposition</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DISPOSITIONS.map((d, i) => (
            <label
              key={d}
              className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-[14px] transition ${disposition === d ? 'border-brand bg-brand-tint text-brand' : 'border-line-strong hover:border-brand'}`}
            >
              <input
                type="radio"
                name="disposition"
                value={d}
                checked={disposition === d}
                onChange={() => {
                  setDisposition(d);
                  setDispositionTouched(true);
                }}
                className="sr-only"
              />
              <kbd className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-xs ${disposition === d ? 'border-brand/40' : 'border-line-strong text-ink-faint'}`}>{i + 1}</kbd>
              {d}
            </label>
          ))}
        </div>
      </fieldset>

      {needsLead && (
        <div className="space-y-4 rounded-card border-2 border-brand/20 bg-brand-tint/50 p-4 sm:p-5">
          <p className="flex items-center gap-2 font-display text-[15px] font-medium text-brand">
            <CheckCircle2 size={18} /> Creates a Lead in Airtable ({disposition === APPOINTMENT_SET ? 'Booking' : 'Nurture'})
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lead-name" label="Prospect full name" value={fullName} onChange={setFullName} required />
            <Field id="lead-email" label="Email address" type="email" value={email} onChange={setEmail} />
            <Field id="lead-phone" label="Phone number" type="tel" value={phone} onChange={setPhone} />
            {disposition === NEEDS_FOLLOW_UP && <Field id="lead-follow-up" label="Next follow-up" type="date" value={nextFollowUp} onChange={setNextFollowUp} />}
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
          Notes {needsLead && <span className="font-normal text-ink-faint">(saved to the Lead's Notes (Maronly))</span>}
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
            <AlertTriangle size={16} /> The call was saved, but the Lead couldn't be created in Airtable.
          </p>
          <p className="mt-1 text-amber-800">{leadError}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => submit()} disabled={submitting}>
              Retry Lead
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDone({ disposition: disposition as Disposition, pickup: pickup as PickupStatus })}>
              Continue without it
            </Button>
          </div>
        </div>
      )}

      {!leadError && (
        <Button type="submit" size="md" className="w-full" disabled={submitting || call.phase !== 'ended'}>
          {submitting ? (
            <>
              <Spinner /> Saving…
            </>
          ) : call.phase !== 'ended' ? (
            'Hang up to save'
          ) : (
            'Save & continue'
          )}
        </Button>
      )}
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
