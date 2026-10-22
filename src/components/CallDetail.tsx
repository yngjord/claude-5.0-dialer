import { CheckCircle2 } from 'lucide-react';
import { useEffect } from 'react';
import { formatPhone } from '../../shared/phone';
import type { CallMediaResponse, CallRow } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { api, must, useLoad } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { supabase } from '../lib/supabase';
import { DISPOSITION_TONES, PICKUP_TONES } from '../lib/tones';
import { Badge } from './ui/Badge';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { ErrorState } from './ui/States';

/** One call or voicemail: details, recording and transcript. Opening a voicemail marks it as heard. */
export function CallDetail({ callId }: { callId: string }) {
  const { me } = useAuth();
  const call = useLoad(async () => must(await supabase.from('calls').select('*').eq('id', callId).maybeSingle()) as CallRow | null, [callId]);
  const media = useLoad(() => api<CallMediaResponse>(`call-media?id=${encodeURIComponent(callId)}`), [callId]);

  const row = call.data;
  useEffect(() => {
    if (row?.kind === 'voicemail' && !row.read_at && row.user_id === me?.userId) {
      supabase.from('calls').update({ read_at: new Date().toISOString() }).eq('id', row.id).then(() => window.dispatchEvent(new Event('inbox:changed')));
    }
  }, [row, me?.userId]);

  if (call.error) return <ErrorState message={call.error} onRetry={call.reload} />;
  if (call.loading) return <Spinner className="text-brand" />;
  if (!row) return <ErrorState message="Call not found, or you don't have access to it." />;

  const voicemail = row.kind === 'voicemail';
  return (
    <div className="space-y-5">
      <div>
        <p className="font-display text-xl font-medium">{row.full_name || formatPhone(row.phone_e164)}</p>
        <p className="mt-1 text-sm text-ink-muted">
          {[voicemail ? 'Voicemail from' : null, formatPhone(row.phone_e164), row.company, row.campaign_name].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-muted">{formatDateTime(row.started_at)}</span>
          {row.agent_name && <span className="text-ink-faint">· {row.agent_name}</span>}
          {row.duration_s != null && <span className="text-ink-faint">· {formatDuration(row.duration_s)}</span>}
          {row.pickup_status && <Badge tone={PICKUP_TONES[row.pickup_status] ?? 'grey'}>{row.pickup_status}</Badge>}
          {row.disposition && <Badge tone={DISPOSITION_TONES[row.disposition] ?? 'grey'}>{row.disposition}</Badge>}
          {row.source === 'justcall' && <Badge tone="grey">JustCall</Badge>}
        </div>
        {row.airtable_lead_id && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 size={15} /> Lead created in Airtable
          </p>
        )}
        {row.lead_sync_error && !row.airtable_lead_id && <p className="mt-3 text-sm text-amber-700">Lead not created: {row.lead_sync_error}</p>}
      </div>

      {row.notes && (
        <div>
          <h3 className="mb-1 font-display text-[13px] font-medium text-ink-muted">Notes</h3>
          <p className="whitespace-pre-wrap text-[15px]">{row.notes}</p>
        </div>
      )}

      <div>
        <h3 className="mb-2 font-display text-[13px] font-medium text-ink-muted">Recording</h3>
        {media.loading ? (
          <div className="skeleton h-10 w-full" />
        ) : media.data?.recordingUrl ? (
          <audio controls preload="metadata" src={media.data.recordingUrl} className="w-full" />
        ) : (
          <p className="text-sm text-ink-faint">{row.recording_sid ? 'Still processing. Check back in a minute.' : voicemail ? 'No message was left.' : 'No recording.'}</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-display text-[13px] font-medium text-ink-muted">Transcript</h3>
        {media.data?.transcriptJson?.length ? (
          <ol className="max-h-[360px] space-y-3 overflow-y-auto rounded-2xl bg-neutral-50 p-4 text-[15px]">
            {media.data.transcriptJson.map((t, i) => (
              <li key={i}>
                <span className="mr-2 font-medium text-brand">{t.speaker}</span>
                {t.start != null && <span className="mr-2 text-xs tabular-nums text-ink-faint">{formatDuration(t.start)}</span>}
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        ) : media.data?.transcript ? (
          <p className="max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-2xl bg-neutral-50 p-4 text-[15px]">{media.data.transcript}</p>
        ) : (
          <p className="text-sm text-ink-faint">
            {media.data?.transcriptStatus === 'pending' ? 'Transcribing…' : media.data?.transcriptStatus === 'failed' ? 'Transcription failed.' : 'No transcript for this call.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function CallDetailModal({ callId, onClose }: { callId: string; onClose: () => void }) {
  return (
    <Modal title="Call details" onClose={onClose} size="lg">
      <CallDetail callId={callId} />
    </Modal>
  );
}

