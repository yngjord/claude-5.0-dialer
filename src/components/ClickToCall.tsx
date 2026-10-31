import { Phone } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { formatPhone } from '../../shared/phone';
import type { Campaign, Contact } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { lockedByTeammate } from '../lib/locks';
import { useVoice } from '../voice/VoiceProvider';
import { CallControls } from './CallControls';
import { ContactCard } from './ContactCard';
import { Modal } from './ui/Modal';
import { WrapUpForm } from './WrapUpForm';

/** Phone button for a contact row: calls straight from the browser, outside a power dialer session. */
export function CallButton({ contact, campaign }: { contact: Contact; campaign: Campaign }) {
  const { dial, active } = useVoice();
  const { me } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const locked = lockedByTeammate(contact, me?.userId);
  const blocked = contact.status === 'do_not_call';
  const title = blocked ? 'Do not call' : locked ? 'A teammate is calling this contact' : active ? 'Finish your current call first' : `Call ${formatPhone(contact.phone_e164)}`;

  return (
    <button
      onClick={() => dial(contact, campaign, 'click').catch((err) => setError(err instanceof Error ? err.message : 'Could not call'))}
      disabled={!!active || locked || blocked}
      title={error ?? title}
      aria-label={title}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-hover disabled:bg-neutral-200 disabled:text-ink-faint"
    >
      <Phone size={16} />
    </button>
  );
}

/**
 * Shows a call in progress at the top of every page, then the wrap-up form when it ends. Covers click-to-call, and
 * power dialer calls when the rep has navigated away from the Dialer page.
 */
export function ClickToCallBar() {
  const { active, clear } = useVoice();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  if (!active) return null;
  if (active.mode === 'power' && pathname === `/campaigns/${active.campaign.id}/dial`) return null;
  const ended = active.phase === 'ended';

  return (
    <>
      <div className="card sticky top-20 z-20 mb-6 animate-appear p-4 lg:top-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="truncate font-display text-[17px] font-medium">{active.contact.full_name || formatPhone(active.contact.phone_e164)}</p>
            <p className="truncate text-sm text-ink-muted">
              {[active.contact.company, formatPhone(active.contact.phone_e164), active.campaign.name].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <CallControls call={active} compact />
            <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
              {ended ? 'Wrap up' : 'Details & notes'}
            </button>
          </div>
        </div>
      </div>

      {(open || ended) && (
        <Modal title={ended ? 'Wrap up the call' : 'On a call'} onClose={() => (ended ? undefined : setOpen(false))} size="lg">
          <div className="space-y-6">
            {!ended && <ContactCard contact={active.contact} sms={active.mode !== 'oneoff'} />}
            <WrapUpForm
              call={active}
              onDone={() => {
                setOpen(false);
                clear();
              }}
            />
            {/* The call never reached Twilio (e.g. connection error), so there's nothing to wrap up. */}
            {ended && !active.row && active.error && (
              <button onClick={clear} className="w-full text-center text-sm text-ink-muted hover:text-ink">
                The call didn't go through. Dismiss
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
