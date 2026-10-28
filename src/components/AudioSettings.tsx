import { Headphones, Mic, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { canPickSpeaker, useAudioDevices } from '../voice/audioDevices';
import { playTestSound } from '../voice/ringback';
import { useVoice } from '../voice/VoiceProvider';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

/**
 * Sidebar: the microphone and speaker calls will use, so the rep can check before starting a campaign. Clicking
 * opens a picker; the choice is remembered in this browser and applies from the next call (the speaker straight away).
 */
export function AudioDevicesLine() {
  const { deviceState, active } = useVoice();
  const [open, setOpen] = useState(false);
  // Device names appear once the browser has microphone access, i.e. after the phone is turned on.
  const audio = useAudioDevices(deviceState);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Choose your microphone and speaker"
        className="mt-1.5 w-full space-y-0.5 rounded-xl px-1 py-1 text-left text-xs text-white/80 hover:text-white"
      >
        <span className="flex items-center gap-2">
          <Mic size={13} className="shrink-0" />
          <span className="truncate">{audio.labelled ? audio.micLabel : 'Microphone: turn on the phone to see it'}</span>
        </span>
        {audio.labelled && (
          <span className="flex items-center gap-2">
            <Volume2 size={13} className="shrink-0" />
            <span className="truncate">{canPickSpeaker ? audio.speakerLabel : 'System speaker'}</span>
          </span>
        )}
      </button>
      {open && <AudioSettingsModal onClose={() => setOpen(false)} onCall={!!active && active.phase !== 'ended'} />}
    </>
  );
}

function AudioSettingsModal({ onClose, onCall }: { onClose: () => void; onCall: boolean }) {
  const { deviceState, start } = useVoice();
  const audio = useAudioDevices(deviceState);
  const select = 'field !py-2.5 text-sm';

  return (
    <Modal
      title="Audio devices"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      {!audio.labelled ? (
        <div className="space-y-3 text-sm text-ink-muted">
          <p>Your browser shows the device names once it has microphone access. Turn on the phone to choose.</p>
          <Button onClick={() => start().catch(() => undefined)} disabled={deviceState === 'starting'}>
            <Headphones size={16} /> Turn on the phone
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="audio-mic" className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-soft">
              <Mic size={15} /> Microphone
            </label>
            <select id="audio-mic" className={select} value={audio.micId} onChange={(e) => audio.setMic(e.target.value)}>
              <option value="">Computer default</option>
              {audio.mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </select>
            {onCall && <p className="mt-1.5 text-xs text-ink-muted">A new microphone applies from your next call.</p>}
          </div>
          <div>
            <label htmlFor="audio-speaker" className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-soft">
              <Volume2 size={15} /> Speaker
            </label>
            {canPickSpeaker ? (
              <div className="flex gap-2">
                <select id="audio-speaker" className={select} value={audio.speakerId} onChange={(e) => audio.setSpeaker(e.target.value)}>
                  <option value="">Computer default</option>
                  {audio.speakers.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Speaker'}
                    </option>
                  ))}
                </select>
                <Button variant="outline" onClick={playTestSound}>
                  Test
                </Button>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">This browser always uses your computer's sound output. Change it in your computer's sound settings, or use Chrome to pick here.</p>
            )}
          </div>
          <p className="text-xs text-ink-muted">Remembered on this computer. A headset plugged in later shows up here automatically.</p>
        </div>
      )}
    </Modal>
  );
}
