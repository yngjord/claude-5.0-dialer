import { Grid3x3, Mic, MicOff, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration } from '../lib/format';
import type { ActiveCall } from '../voice/VoiceProvider';
import { callStatusLabel } from '../voice/status';
import { useVoice } from '../voice/VoiceProvider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? (now - since) / 1000 : null;
}

export function CallControls({ call, compact = false }: { call: ActiveCall; compact?: boolean }) {
  const { hangUp, toggleMute, sendDigits } = useVoice();
  const [keypad, setKeypad] = useState(false);
  const status = callStatusLabel(call);
  const answeredAt = call.row?.answered_at ? new Date(call.row.answered_at).getTime() : call.answeredAt;
  const elapsed = useElapsed(call.phase === 'ended' ? null : answeredAt);
  const onCall = call.phase !== 'ended';

  return (
    <div>
      <div className={`flex items-center ${compact ? 'gap-3' : 'flex-col gap-4 sm:flex-row sm:justify-between'}`}>
        <div className="flex items-center gap-3">
          <span
            className={`relative flex h-3 w-3 ${status.tone === 'live' ? '' : 'opacity-70'}`}
            aria-hidden
          >
            {status.tone === 'live' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className={`relative inline-flex h-3 w-3 rounded-full ${status.tone === 'live' ? 'bg-emerald-500' : status.tone === 'warn' ? 'bg-amber-400' : 'bg-neutral-300'}`} />
          </span>
          <span className="font-display text-[15px] font-medium" role="status">
            {status.label}
          </span>
          {elapsed != null && <span className="tabular-nums text-ink-muted">{formatDuration(elapsed)}</span>}
        </div>

        {onCall && (
          <div className="flex items-center gap-2">
            <button
              onClick={toggleMute}
              aria-pressed={call.muted}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${call.muted ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-line-strong hover:border-brand hover:text-brand'}`}
              aria-label={call.muted ? 'Unmute' : 'Mute'}
              title={call.muted ? 'Unmute' : 'Mute'}
            >
              {call.muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={() => setKeypad((k) => !k)}
              aria-pressed={keypad}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${keypad ? 'border-brand text-brand' : 'border-line-strong hover:border-brand hover:text-brand'}`}
              aria-label="Keypad"
              title="Keypad"
            >
              <Grid3x3 size={18} />
            </button>
            <button
              onClick={hangUp}
              className="flex h-11 items-center gap-2 rounded-full bg-red-600 px-5 font-medium text-white transition hover:bg-red-700"
            >
              <PhoneOff size={18} /> Hang up
            </button>
          </div>
        )}
      </div>

      {keypad && onCall && (
        <div className="mx-auto mt-4 grid max-w-[220px] grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button key={k} onClick={() => sendDigits(k)} className="h-11 rounded-2xl border border-line-strong font-display text-lg transition hover:border-brand hover:text-brand">
              {k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
