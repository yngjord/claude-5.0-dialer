import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';

/** Copies a permanent, no-login link to the call's recording (/r/{id}.mp3), e.g. to send to a client. */
export function ShareRecordingButton({ callId }: { callId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');
  const copy = async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      const { url } = await api<{ url: string }>('call-share', { method: 'POST', body: JSON.stringify({ id: callId }) });
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="A link that plays this recording without logging in"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm text-ink-muted transition hover:bg-black/[0.04] hover:text-ink"
    >
      {state === 'copied' ? <Check size={14} className="text-emerald-600" /> : <Link2 size={14} />}
      {state === 'copied' ? 'Link copied' : state === 'error' ? "Couldn't copy" : 'Copy share link'}
    </button>
  );
}
