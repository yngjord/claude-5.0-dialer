import { LogOut, Pause, Phone, PhoneOutgoing, SkipForward, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { APPOINTMENT_SET, CONNECTED_PICKUP_STATUS, NEEDS_FOLLOW_UP } from '../../shared/constants';
import { formatPhone } from '../../shared/phone';
import type { Campaign, Contact } from '../../shared/types';
import { CallControls } from '../components/CallControls';
import { ContactCard } from '../components/ContactCard';
import LoadingBar from '../components/LoadingBar';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/States';
import { WrapUpForm, type WrapUpResult } from '../components/WrapUpForm';
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
 * Power dialer: claims the next contact from the campaign queue (never the same one as a teammate) and dials it per
 * the auto-dial setting. After the call, "Save & dial next" calls the next contact straight away; "Save" moves on to
 * them and follows the auto-dial setting again.
 */
export default function Dialer() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { active, dial, clear, start, deviceState, deviceError } = useVoice();
  const campaignQuery = useLoad(async () => must(await supabase.from('dialer_campaigns').select('*').eq('id', id).maybeSingle()) as Campaign | null, [id]);
  const campaign = campaignQuery.data;

  const [stage, setStage] = useState<Stage>('idle');
  const [contact, setContact] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delay, setDelay] = useState(readDelay);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [session, setSession] = useState({ dials: 0, connects: 0, leads: 0 });

  // The contact we hold a queue lock on but haven't called yet, so leaving the page can give it back.
  const heldRef = useRef<string | null>(null);
  heldRef.current = stage === 'ready' && contact ? contact.id : null;
  useEffect(
    () => () => {
      if (heldRef.current) supabase.rpc('dialer_release_contact', { p_contact_id: heldRef.current, p_skip: false });
    },
    [],
  );

  const myCall = active && active.mode === 'power' && active.campaign.id === id ? active : null;

  // `dialAfter` overrides the auto-dial setting for this contact (0 = dial straight away).
  const claimNext = useCallback(async (dialAfter?: number) => {
    setStage('claiming');
    setError(null);
    try {
      const rows = must(await supabase.rpc('dialer_claim_next_contact', { p_campaign_id: id })) as Contact[];
      if (!rows.length) {
        setContact(null);
        setStage('empty');
        return;
      }
      setContact(rows[0]);
      setStage('ready');
      const wait = dialAfter ?? delay;
      setCountdown(wait >= 0 ? wait : null);
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
      await claimNext();
    } catch {
      // deviceError explains it
    }
  };

  const skip = async () => {
    if (contact) await supabase.rpc('dialer_release_contact', { p_contact_id: contact.id, p_skip: true });
    await claimNext();
  };

  const stop = async () => {
    if (stage === 'ready' && contact) await supabase.rpc('dialer_release_contact', { p_contact_id: contact.id, p_skip: false });
    setContact(null);
    setCountdown(null);
    setStage('paused');
  };

  const afterWrapUp = (result: WrapUpResult) => {
    setSession((s) => ({
      ...s,
      connects: s.connects + (result.pickup === CONNECTED_PICKUP_STATUS ? 1 : 0),
      leads: s.leads + (result.disposition === APPOINTMENT_SET || result.disposition === NEEDS_FOLLOW_UP ? 1 : 0),
    }));
    clear();
    setContact(null);
    claimNext(result.dialNext ? 0 : undefined);
  };

  // The call never reached Twilio (connection error): nothing to wrap up, let the rep retry or move on.
  const failedToStart = myCall?.phase === 'ended' && !myCall.row && !!myCall.error;
  const retryFailed = () => {
    clear();
    setStage('ready');
  };

  // Can't leave mid-call or with a wrap-up still to save (the call would go unlogged).
  const endBlocked = !!myCall && !failedToStart;
  const endSession = () => {
    if (!endBlocked) navigate('/campaigns');
  };

  if (campaignQuery.error || (!campaignQuery.loading && !campaign)) {
    return (
      <FocusLayout title="Power dialer" onEnd={endSession} endBlocked={false}>
        <ErrorState message={campaignQuery.error ?? "Campaign not found, or you're not assigned to it."} onRetry={campaignQuery.error ? campaignQuery.reload : undefined} />
      </FocusLayout>
    );
  }

  const shown = myCall?.contact ?? contact;

  return (
    <FocusLayout
      title={campaign?.name ?? 'Power dialer'}
      subtitle={campaign?.client_name}
      onEnd={endSession}
      endBlocked={endBlocked}
      toolbar={
        <>
          <div className="flex items-center gap-1 rounded-full border border-line bg-white py-1 pl-3.5 pr-1 text-sm" aria-label="This session">
            <span className="mr-1 text-xs text-ink-muted">This session</span>
            {(
              [
                ['dials', session.dials],
                ['connects', session.connects],
                ['leads', session.leads],
              ] as const
            ).map(([label, n]) => (
              <span key={label} className="rounded-full bg-neutral-100 px-2.5 py-1">
                <b className="font-display font-medium tabular-nums">{n}</b> <span className="text-ink-muted">{label}</span>
              </span>
            ))}
          </div>
          <label className="sr-only" htmlFor="auto-delay">
            Auto-dial
          </label>
          <select
            id="auto-delay"
            className="field !w-auto !py-2 text-sm"
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
        </>
      }
    >
      <div className="mx-auto max-w-3xl">
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
                <p className="font-display text-xl">No one left to call</p>
                <p className="max-w-md text-ink-muted">Everyone in this campaign has been called. An admin can re-run it for contacts by disposition (e.g. No Answer), or import more contacts.</p>
                <Button variant="outline" onClick={() => claimNext()}>
                  Check again
                </Button>
              </>
            ) : (
              <>
                <PhoneOutgoing className="text-brand" size={32} />
                <p className="font-display text-xl">{stage === 'paused' ? 'Paused' : 'Ready when you are'}</p>
                <p className="max-w-md text-ink-muted">
                  Calls go out from your browser. Use a headset, and allow microphone access when your browser asks. After each call, fill in the wrap-up and move on to the next contact.
                </p>
                <Button size="md" onClick={begin} disabled={deviceState === 'starting' || campaign?.status !== 'active'}>
                  {deviceState === 'starting' ? <Spinner /> : <Phone size={18} />} {stage === 'paused' ? 'Resume dialing' : 'Start dialing'}
                </Button>
                {campaign && campaign.status !== 'active' && <p className="text-sm text-amber-700">This campaign is {campaign.status}.</p>}
              </>
            )}
          </div>
        ) : (
          <div className="animate-appear space-y-6">
            <section className="card p-5 sm:p-8">
              <ContactCard key={shown.id} contact={shown} centered history={false} sms={false}>
                {myCall ? (
                  <div className="border-t border-line pt-6">
                    <CallControls call={myCall} />
                    {failedToStart && (
                      <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
                        <p>The call didn't go through: {myCall.error}</p>
                        <div className="mt-3 flex justify-center gap-2">
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
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4 border-t border-line pt-6">
                    {countdown != null && countdown > 0 && (
                      <p className="font-display text-[15px] text-brand" role="status">
                        Dialing in {countdown}…
                      </p>
                    )}
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="md" onClick={callNow} disabled={!!active}>
                        <Phone size={18} /> Call {formatPhone(shown.phone_e164)}
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
              </ContactCard>
            </section>

            {myCall && !failedToStart && (
              <section className="card p-5 sm:p-8">
                <WrapUpForm key={myCall.callId} call={myCall} onDone={afterWrapUp} dialNextOption />
              </section>
            )}
          </div>
        )}
      </div>
    </FocusLayout>
  );
}

/**
 * The dialer runs full screen with no sidebar, so reps aren't distracted. "End dialling session" is the way back
 * to Campaigns (the browser's back button works too).
 */
function FocusLayout({
  title,
  subtitle,
  toolbar,
  onEnd,
  endBlocked,
  children,
}: {
  title: string;
  subtitle?: string;
  toolbar?: ReactNode;
  onEnd: () => void;
  endBlocked: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <LoadingBar />
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-10">
          <img src="/maronly-mark.png" alt="Maronly" className="h-8 w-8" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-[17px] font-medium leading-tight">{title}</p>
            {subtitle && <p className="truncate text-xs text-ink-muted">{subtitle}</p>}
          </div>
          {toolbar && <div className="order-last flex w-full flex-wrap items-center gap-2 md:order-none md:w-auto">{toolbar}</div>}
          <Button variant="outline" onClick={onEnd} disabled={endBlocked} title={endBlocked ? 'Hang up and save the wrap-up first' : undefined}>
            <LogOut size={16} /> End dialling session
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 sm:px-6 lg:px-10">{children}</main>
    </div>
  );
}
