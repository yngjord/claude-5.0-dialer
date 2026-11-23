import { CalendarClock, FileText, Play } from 'lucide-react';
import { useState } from 'react';
import type { CallMediaResponse, CallRow, Contact } from '../../shared/types';
import { api, must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';
import { Spinner } from './ui/Spinner';

/**
 * For a contact being called back: when it was booked for, the notes from the call that booked it, and that call's
 * recording and transcript, so the rep has the full context before dialling.
 */
export function CallbackContext({ contact }: { contact: Contact }) {
  const booked = useLoad(
    async () =>
      must(
        await supabase
          .from('dialer_calls')
          .select('id, started_at, notes, agent_name, recording_path, recording_sid, duration_s')
          .eq('contact_id', contact.id)
          .eq('disposition', 'Callback')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as Pick<CallRow, 'id' | 'started_at' | 'notes' | 'agent_name' | 'recording_path' | 'recording_sid' | 'duration_s'> | null,
    [contact.id],
  );

  return (
    <div className="mx-auto mb-6 max-w-xl rounded-2xl border border-purple-200 bg-purple-50/60 px-4 py-3 text-left text-sm">
      <p className="flex items-center gap-2 font-medium text-purple-900">
        <CalendarClock size={16} /> Callback{contact.next_attempt_at ? ` booked for ${formatDateTime(contact.next_attempt_at)}` : ''}
      </p>
      {booked.loading ? (
        <div className="skeleton mt-2 h-4 w-2/3" />
      ) : booked.data ? (
        <>
          <p className="mt-1 text-xs text-purple-900/70">From your call on {formatDateTime(booked.data.started_at)}</p>
          <p className="mt-2 whitespace-pre-wrap text-ink-soft">{booked.data.notes || 'No notes were left on that call.'}</p>
          {(booked.data.recording_path || booked.data.recording_sid) && <PreviousCall callId={booked.data.id} durationS={booked.data.duration_s} />}
        </>
      ) : null}
    </div>
  );
}

/** The booking call's recording (loaded on demand: the link is short-lived) and, if wanted, its transcript. */
function PreviousCall({ callId, durationS }: { callId: string; durationS: number | null }) {
  const [media, setMedia] = useState<CallMediaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setMedia(await api<CallMediaResponse>(`call-media?id=${encodeURIComponent(callId)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the recording.');
    } finally {
      setLoading(false);
    }
  };

  if (!media) {
    return (
      <div className="mt-3">
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-white px-3 py-1.5 text-sm text-purple-800 transition hover:border-purple-400 disabled:opacity-60"
        >
          {loading ? <Spinner /> : <Play size={14} />} Listen to that call{durationS ? ` (${formatDuration(durationS)})` : ''}
        </button>
        {error && <p className="mt-1.5 text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  const turns = media.transcriptJson ?? [];
  return (
    <div className="mt-3 animate-fade-in space-y-2">
      {media.recordingUrl ? (
        <audio controls autoPlay preload="metadata" src={media.recordingUrl} className="w-full" />
      ) : (
        <p className="text-xs text-ink-faint">The recording is still processing. Try again in a minute.</p>
      )}
      {(turns.length > 0 || media.transcript) && (
        <button onClick={() => setShowTranscript((s) => !s)} className="inline-flex items-center gap-1.5 text-xs text-purple-800 hover:underline">
          <FileText size={13} /> {showTranscript ? 'Hide transcript' : 'Show transcript'}
        </button>
      )}
      {showTranscript && (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl bg-white p-3 text-[13px]">
          {turns.length
            ? turns.map((t, i) => (
                <p key={i}>
                  <span className="mr-1.5 font-medium text-purple-800">{t.speaker}</span>
                  {t.start != null && <span className="mr-1.5 text-xs tabular-nums text-ink-faint">{formatDuration(t.start)}</span>}
                  {t.text}
                </p>
              ))
            : <p className="whitespace-pre-wrap">{media.transcript}</p>}
        </div>
      )}
    </div>
  );
}
