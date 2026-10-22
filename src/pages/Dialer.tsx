import { ArrowLeft, Pause, Phone, PhoneOutgoing, SkipForward, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { APPOINTMENT_SET, CONNECTED_PICKUP_STATUS, NEEDS_FOLLOW_UP } from '../../shared/constants';
import { formatPhone } from '../../shared/phone';
import type { Campaign, Contact } from '../../shared/types';
import { CallControls } from '../components/CallControls';
import { ContactCard } from '../components/ContactCard';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/States';
import { WrapUpForm } from '../components/WrapUpForm';
import { must, useLoad } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useVoice } from '../voice/VoiceProvider';

type Stage = 'idle' | 'claiming' | 'ready' | 'calling' | 'empty' | 'paused';

const DELAYS = [
  { value: 0, label: 'Dial straight away' },
  { value: 3, label: 'Dial after 3s' },
  { value: 5, label: 'Dial after 5s' },
  { value: -1, label: 'Wait for me to press Call' },
];
const DELAY_KEY = 'dialer:autoDelay';

function readDelay(): number {
  try {
    const v = Number(localStorage.getItem(DELAY_KEY));
    return DELAYS.some((d) => d.value === v) && localStorage.getItem(DELAY_KEY) !== null ? v : 3;
  } catch {
    return 3;
  }
}

/**
 * Power dialer: claims the next contact from the campaign queue (never the same one as a teammate), dials it after
 * a short countdown, then shows the wrap-up form; saving it moves straight on to the next contact.
 */
export default function Dialer() {
  const { id = '' } = useParams();
  const { active, dial, clear, start, deviceState, deviceError } = useVoice();
  const campaignQuery = useLoad(async () => must(await supabase.from('campaigns').select('*').eq('id', id).maybeSingle()) as Campaign | null, [id]);
  const campaign = campaignQuery.data;

  const [stage, setStage] = useState<Stage>('idle');
  const [contact, setContact] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delay, setDelay] = useState(readDelay);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [pauseAfter, setPauseAfter] = useState(false);
  const [session, setSession] = useState({ dials: 0, connects: 0, leads: 0 });

  // The contact we hold a queue lock on but haven't called yet, so leaving the page can give it back.
  const heldRef = useRef<string | null>(null);
  heldRef.current = stage === 'ready' && contact ? contact.id : null;
  useEffect(
    () => () => {
      if (heldRef.current) supabase.rpc('release_contact', { p_contact_id: heldRef.current, p_skip: false });
    },
    [],
  );

  const myCall = active && active.mode === 'power' && active.campaign.id === id ? active : null;

  const claimNext = useCallback(async () => {
    setStage('claiming');
    setError(null);
    try {
      const rows = must(await supabase.rpc('claim_next_contact', { p_campaign_id: id })) as Contact[];
      if (!rows.length) {
        setContact(null);
        setStage('empty');
        return;
      }
      setContact(rows[0]);
      setStage('ready');
      setCountdown(delay >= 0 ? delay : null);
    } catch (err) {
      setStage('idle');
      setError(err instanceof Error ? err.message : 'Could not get the next contact.');
    }
  }, [id, delay]);

  const callNow = useCallback(async () => {
    if (!contact || !campaign) return;
    setCountdown(null);
    setStage('calling');
    setSession((s) => ({ ...s, dials: s.dials + 1 }));
    try {
      await dial(contact, campaign, 'power');
    } catch (err) {
      setStage('ready');
      setError(err instanceof Error ? err.message : 'Could not start the call.');
    }
  }, [contact, campaign, dial]);

  // Countdown to the automatic dial.
  useEffect(() => {
    if (stage !== 'ready' || countdown == null) return;
    if (countdown <= 0) {
      callNow();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c == null ? c : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [stage, countdown, callNow]);

  const begin = async () => {
    setError(null);
    try {
      await start();
      setPauseAfter(false);
      await claimNext();
    } catch {
      // deviceError explains it
    }
  };

  const skip = async () => {
    if (contact) await supabase.rpc('release_contact', { p_contact_id: contact.id, p_skip: true });
    await claimNext();
  };

  const stop = async () => {
    if (stage === 'ready' && contact) await supabase.rpc('release_contact', { p_contact_id: contact.id, p_skip: false });
    setContact(null);
    setCountdown(null);
    setStage('paused');
  };

  const afterWrapUp = (result: { disposition: string; pickup: string }) => {
    setSession((s) => ({
      ...s,
      connects: s.connects + (result.pickup === CONNECTED_PICKUP_STATUS ? 1 : 0),
      leads: s.leads + (result.disposition === APPOINTMENT_SET || result.disposition === NEEDS_FOLLOW_UP ? 1 : 0),
    }));
    clear();
    setContact(null);
    if (pauseAfter) {
      setPauseAfter(false);
      setStage('paused');
    } else claimNext();
  };

  // The call never reached Twilio (connection error): nothing to wrap up, let the rep retry or move on.
  const failedToStart = myCall?.phase === 'ended' && !myCall.row && !!myCall.error;
  const retryFailed = () => {
    clear();
    setStage('ready');
  };

  if (campaignQuery.error) return <ErrorState message={campaignQuery.error} onRetry={campaignQuery.reload} />;
  if (!campaignQuery.loading && !campaign) return <ErrorState message="Campaign not found, or you're not assigned to it." />;

  const shown = myCall?.contact ?? contact;

  return (
    <>
      <div className="mb-6 flex animate-appear flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Link to={`/campaigns/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-brand">
            <ArrowLeft size={15} /> {campaign?.name ?? 'Campaign'}
          </Link>
          <h1 className="font-display text-[30px] font-normal leading-tight sm:text-[36px]">Power dialer</h1>
          <p className="mt-1 text-[15px] text-ink-muted">{campaign?.client_name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <dl className="flex gap-2 text-center text-sm">
            {(
              [
                ['Dials', session.dials],
                ['Connects', session.connects],
                ['Leads', session.leads],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-2xl border border-line bg-white px-4 py-2">
                <dt className="text-[11px] text-ink-muted">{label}</dt>
                <dd className="font-display text-lg font-medium tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
          <label className="sr-only" htmlFor="auto-delay">
            Auto-dial
          </label>
          <select
            id="auto-delay"
            className="field !w-auto !py-2.5 text-sm"
            value={delay}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDelay(v);
              try {
                localStorage.setItem(DELAY_KEY, String(v));
              } catch {
                // per-browser convenience only
              }
            }}
          >
            {DELAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(error || deviceError) && (
        <p role="alert" className="mb-5 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? deviceError}
        </p>
      )}

      {!shown ? (
        <div className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
          {stage === 'claiming' ? (
            <>
              <Spinner className="text-brand" size={24} />
              <p className="text-ink-muted">Getting the next contact…</p>
            </>
          ) : stage === 'empty' ? (
            <>
              <p className="font-display text-xl">No one left to call right now</p>
              <p className="max-w-md text-ink-muted">Everyone is done, maxed out on attempts, or waiting for their callback time. Import more contacts or check back later.</p>
              <Button variant="outline" onClick={claimNext}>
                Check again
              </Button>
            </>
          ) : (
            <>
              <PhoneOutgoing className="text-brand" size={32} />
              <p className="font-display text-xl">{stage === 'paused' ? 'Paused' : 'Ready when you are'}</p>
              <p className="max-w-md text-ink-muted">
                Calls go out from your browser. Use a headset, and allow microphone access when your browser asks. After each call, fill in the wrap-up and the next contact is dialed for you.
              </p>
              <Button size="md" onClick={begin} disabled={deviceState === 'starting' || campaign?.status !== 'active'}>
                {deviceState === 'starting' ? <Spinner /> : <Phone size={18} />} {stage === 'paused' ? 'Resume dialing' : 'Start dialing'}
              </Button>
              {campaign && campaign.status !== 'active' && <p className="text-sm text-amber-700">This campaign is {campaign.status}.</p>}
            </>
          )}
        </div>
      ) : (
        <div className="grid animate-appear gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <section className="card p-5 sm:p-7">
            <ContactCard key={shown.id} contact={shown} />
          </section>

          <section className="card p-5 sm:p-6">
            {myCall ? (
              <div className="space-y-6">
                <CallControls call={myCall} />
                {failedToStart ? (
                  <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
                    <p>The call didn't go through: {myCall.error}</p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" onClick={retryFailed}>
                        Try again
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          clear();
                          await skip();
                        }}
                      >
                        Skip contact
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <WrapUpForm key={myCall.callId} call={myCall} onDone={afterWrapUp} />
                    <label className="flex items-center gap-2 text-sm text-ink-muted">
                      <input type="checkbox" checked={pauseAfter} onChange={(e) => setPauseAfter(e.target.checked)} className="h-4 w-4 accent-brand" />
                      Pause after this call
                    </label>
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-5 py-6 text-center">
                <p className="text-sm text-ink-muted">Next up</p>
                <p className="font-display text-2xl tabular-nums">{formatPhone(shown.phone_e164)}</p>
                {countdown != null && countdown > 0 && (
                  <p className="font-display text-[15px] text-brand" role="status">
                    Dialing in {countdown}…
                  </p>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="md" onClick={callNow} disabled={!!active}>
                    <Phone size={18} /> Call now
                  </Button>
                  <Button size="md" variant="outline" onClick={skip}>
                    <SkipForward size={18} /> Skip
                  </Button>
                </div>
                <button onClick={stop} className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
                  {countdown != null ? <Pause size={14} /> : <Square size={14} />} Stop dialing
                </button>
              </div>
            )}
          </section>
        </div>
      )}

    </>
  );
}
