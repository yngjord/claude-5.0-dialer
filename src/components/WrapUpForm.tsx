import { AlertTriangle, CalendarClock, CalendarPlus, CheckCircle2, Phone } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { APPOINTMENT_SET, CALLBACK, DISPOSITIONS, LEAD_DISPOSITIONS, PICKUP_STATUSES, type Disposition, type PickupStatus } from '../../shared/constants';
import { invitesBroken, parseGuests, renderTemplate, sendsInvites, validateInvite, type InviteInput } from '../../shared/calendar';
import { validateLead } from '../../shared/leads';
import { zonedTimeToUtc } from '../../shared/time';
import type { WrapUpRequest, WrapUpResponse } from '../../shared/types';
import { api } from '../lib/api';
import { useClientCalendar } from '../lib/useClientCalendar';
import { timeBookedText, ZONES } from '../lib/bookingTime';
import type { ActiveCall } from '../voice/VoiceProvider';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

/** Disposition that fits the pickup when the rep hasn't picked one: saves a click on the many unanswered dials. */
function suggestedDisposition(pickup: PickupStatus | null): Disposition | null {
  // Voicemail picked up (Machine Pickup) counts as No Answer too; the rep can switch it to Left Voicemail.
  if (pickup === 'Unanswered' || pickup === 'Busy' || pickup === 'Failed' || pickup === 'Machine Pickup') return 'No Answer';
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
/** Editing a call that was already saved: its saved values, and whether it already created a CRM lead. */
export interface SavedWrapUp {
  disposition: Disposition | null;
  notes: string | null;
  /** The booked callback time (Callback only). */
  callbackAt: string | null;
  leadCreated: boolean;
}

/** "2026-10-29T01:30:00Z" in Sydney → ["2026-10-29", "12:30"]. */
function zonedParts(iso: string, tz: string): [string, string] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}

export function WrapUpForm({
  call,
  onDone,
  dialNextOption = false,
  saved,
}: {
  call: ActiveCall;
  onDone: (result: WrapUpResult) => void;
  dialNextOption?: boolean;
  /** Set when correcting a call that was already saved: the form starts from what was saved. */
  saved?: SavedWrapUp;
}) {
  const livePickup = call.row?.pickup_status ?? null;
  const [pickup, setPickup] = useState<PickupStatus | ''>(livePickup ?? '');
  const [pickupTouched, setPickupTouched] = useState(!!saved);
  const [disposition, setDisposition] = useState<Disposition | ''>(saved ? (saved.disposition ?? '') : (suggestedDisposition(livePickup) ?? ''));
  const [dispositionTouched, setDispositionTouched] = useState(!!saved);
  const [notes, setNotes] = useState(saved?.notes ?? '');
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
  // Callback: when to call back, in the prospect's time zone.
  const savedCallback = saved?.callbackAt ? zonedParts(saved.callbackAt, tz) : null;
  const [cbDate, setCbDate] = useState(savedCallback?.[0] ?? '');
  const [cbTime, setCbTime] = useState(savedCallback?.[1] ?? '');
  const callbackAt = disposition === CALLBACK && cbDate && cbTime ? zonedTimeToUtc(cbDate, cbTime, tz) : null;
  const preset = (hoursFromNow: number | 'tomorrow9') => {
    const at = hoursFromNow === 'tomorrow9' ? null : new Date(Date.now() + hoursFromNow * 3_600_000);
    const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
    if (at) {
      const p = parts(at);
      setCbDate(`${p.year}-${p.month}-${p.day}`);
      setCbTime(`${p.hour}:${p.minute}`);
    } else {
      const p = parts(new Date(Date.now() + 86_400_000));
      setCbDate(`${p.year}-${p.month}-${p.day}`);
      setCbTime('09:00');
    }
  };

  // Twilio's result can land a second or two after hang-up: keep following it until the rep changes it.
  useEffect(() => {
    if (!pickupTouched && livePickup) setPickup(livePickup);
    if (!dispositionTouched && livePickup) setDisposition((d) => d || suggestedDisposition(livePickup) || '');
  }, [livePickup, pickupTouched, dispositionTouched]);

  // A lead already made from this call isn't made again (or changed), so its details aren't asked for again.
  const leadExists = !!saved?.leadCreated;
  // Click-to-call calls have no campaign: they don't make CRM leads or book callbacks.
  const oneOff = call.mode === 'oneoff';
  const needsLead = !!disposition && LEAD_DISPOSITIONS.includes(disposition) && !leadExists && !oneOff;
  // Google Calendar invite: only for clients whose host connected their calendar and has invites switched on.
  const calendar = useClientCalendar(oneOff ? null : call.contact.airtable_client_id);
  const invites = needsLead && disposition === APPOINTMENT_SET && sendsInvites(calendar);
  const vars = { client: call.contact.client_name ?? call.campaign.client_name, company: call.contact.company, prospect: fullName, firstName: call.contact.first_name };
  const [inviteTitle, setInviteTitle] = useState<string | null>(null);
  const [inviteDesc, setInviteDesc] = useState<string | null>(null);
  const [inviteMinutes, setInviteMinutes] = useState<number | null>(null);
  const [extraGuests, setExtraGuests] = useState('');
  // Until the rep edits them, the title and description follow the client's templates (and the prospect's name).
  const title = inviteTitle ?? (calendar ? renderTemplate(calendar.title_template, vars) : '');
  const description = inviteDesc ?? (calendar ? renderTemplate(calendar.description_template, vars) : '');
  const minutes = inviteMinutes ?? calendar?.meeting_minutes ?? 30;
  const invite: InviteInput | null =
    invites && bookedFor && time
      ? {
          title,
          description,
          startsAt: zonedTimeToUtc(bookedFor, time, tz).toISOString(),
          minutes,
          timeZone: tz,
          guests: parseGuests([email, extraGuests].join(',')),
        }
      : null;

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
    if (invites) {
      if (!email.trim()) return setError('Prospect email is required to send the calendar invite.');
      const problems = invite ? validateInvite(invite) : ['Choose when the meeting is.'];
      if (problems.length) return setError(problems.join(' '));
    }
    if (disposition === CALLBACK && !callbackAt) return setError('Choose when to call back.');
    if (callbackAt && callbackAt.getTime() < Date.now()) return setError('The callback time is in the past.');
    setSubmitting(true);
    setError(null);
    try {
      const body: WrapUpRequest = {
        callId: call.callId,
        pickupStatus: pickup,
        disposition,
        notes,
        ...(needsLead ? { lead } : {}),
        ...(invites && invite ? { invite } : {}),
        ...(callbackAt ? { callbackAt: callbackAt.toISOString() } : {}),
      };
      const res = await api<WrapUpResponse>('wrap-up', { method: 'POST', body: JSON.stringify(body) });
      if (res.leadError) {
        setLeadError(res.leadError);
        setSubmitting(false);
        return;
      }
      window.dispatchEvent(new Event('callbacks:changed'));
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
          {DISPOSITIONS.filter((d) => !oneOff || d !== CALLBACK).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {leadExists && !!disposition && LEAD_DISPOSITIONS.includes(disposition) && (
        <p className="rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand">This call already created its lead in the CRM. Saving here won't change the lead.</p>
      )}
      {oneOff && !!disposition && LEAD_DISPOSITIONS.includes(disposition) && (
        <p className="rounded-2xl bg-brand-tint px-4 py-3 text-sm text-brand">Click-to-call calls don't create CRM leads: update the lead in MaronlyOS.</p>
      )}

      {needsLead && (
        <div className="space-y-4 rounded-card border-2 border-brand/20 bg-brand-tint/50 p-4 sm:p-5">
          <p className="flex items-center gap-2 font-display text-[15px] font-medium text-brand">
            <CheckCircle2 size={18} /> {disposition === APPOINTMENT_SET ? 'Creates a new lead and booking request inside the CRM' : 'Creates a new lead inside the CRM'}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lead-name" label="Prospect full name" value={fullName} onChange={setFullName} required />
            <Field id="lead-email" label="Email address" type="email" value={email} onChange={setEmail} required={invites} />
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
          {needsLead && disposition === APPOINTMENT_SET && invitesBroken(calendar) && (
            <p role="alert" className="flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> The client’s Google Calendar is disconnected, so no invite will be sent. The lead and booking request are
              still saved: let an admin know so the invite can be sent by hand.
            </p>
          )}
          {invites && calendar && (
            <div className="space-y-4 rounded-2xl border border-brand/20 bg-white p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-brand">
                <CalendarPlus size={16} /> Sends a Google Calendar invite from {calendar.google_email ?? 'the client’s calendar'}, with a Meet link
              </p>
              <p className="-mt-2 text-xs text-ink-muted">The prospect’s email above is invited. Notes below aren’t sent; only the title and description are.</p>
              <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
                <Field id="invite-title" label="Invite title" value={title} onChange={setInviteTitle} required />
                <div>
                  <label htmlFor="invite-minutes" className="mb-2 block text-sm font-medium text-ink-soft">
                    Length (min)
                  </label>
                  <input
                    id="invite-minutes"
                    type="number"
                    min={5}
                    max={240}
                    step={5}
                    className="field"
                    value={minutes}
                    onChange={(e) => setInviteMinutes(Number(e.target.value))}
                  />
                </div>
              </div>
              <Field id="invite-guests" label="Extra guests (optional)" value={extraGuests} onChange={setExtraGuests} placeholder="name@company.com, another@company.com" />
              <div>
                <label htmlFor="invite-description" className="mb-2 block text-sm font-medium text-ink-soft">
                  Invite description (optional)
                </label>
                <textarea id="invite-description" rows={3} className="field resize-y" value={description} onChange={(e) => setInviteDesc(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      )}

      {disposition === CALLBACK && (
        <div className="space-y-4 rounded-card border-2 border-purple-200 bg-purple-50/60 p-4 sm:p-5">
          <p className="flex items-center gap-2 font-display text-[15px] font-medium text-purple-800">
            <CalendarClock size={18} /> Call back on
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['In 5 minutes', 5 / 60],
                ['In 1 hour', 1],
                ['In 2 hours', 2],
                ['Tomorrow 9am', 'tomorrow9'],
              ] as const
            ).map(([label, h]) => (
              <button key={label} type="button" onClick={() => preset(h)} className="rounded-full border border-purple-200 bg-white px-3 py-1.5 text-sm text-purple-800 hover:border-purple-400">
                {label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <input aria-label="Callback date" type="date" className="field" value={cbDate} onChange={(e) => setCbDate(e.target.value)} />
            <input aria-label="Callback time" type="time" className="field" value={cbTime} onChange={(e) => setCbTime(e.target.value)} />
            <select aria-label="Time zone" className="field !w-auto" value={tz} onChange={(e) => setTz(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z.tz} value={z.tz}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-purple-900/70">Only you will get this contact back, first in your queue once it's due. You'll see it under Callbacks.</p>
        </div>
      )}

      <div>
        <label htmlFor="notes" className="mb-2 block text-sm font-medium text-ink-soft">
          Notes{' '}
          {needsLead ? (
            <span className="font-normal text-ink-faint">(saved to the lead's notes)</span>
          ) : disposition === CALLBACK ? (
            <span className="font-normal text-ink-faint">(shown to you when you call back)</span>
          ) : null}
        </label>
        <textarea
          id="notes"
          rows={3}
          className="field resize-y"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={disposition === CALLBACK ? 'What to remember: who you spoke to, what they asked for, why to call back' : 'What happened on the call?'}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {leadError && (
        <div role="alert" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle size={16} /> The call was saved, but the CRM didn't take everything.
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
        ) : saved ? (
          <Button type="submit" size="md" className="w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null} Save changes
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

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink-soft">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      <input id={id} type={type} className="field" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
