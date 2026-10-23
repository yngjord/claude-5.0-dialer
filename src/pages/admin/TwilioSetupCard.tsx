import { Check, Copy, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import type { TwilioSetupResponse, TwilioStatus } from '../../../shared/types';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { api, useLoad } from '../../lib/api';

/**
 * Shown on Phone numbers until Twilio is fully set up: a checklist of what Netlify has, and a button that runs the
 * one-off setup (TwiML App, transcripts, number webhooks) and shows the two values to add to Netlify.
 */
export function TwilioSetupCard() {
  const status = useLoad(() => api<TwilioStatus>('admin/twilio-setup'), []);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TwilioSetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const s = status.data;
  if (!s || (s.keys && s.authToken && s.twimlApp && s.intelligence && !result)) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api<TwilioSetupResponse>('admin/twilio-setup', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setRunning(false);
    }
  };

  const item = (ok: boolean, label: string) => (
    <li className="flex items-center gap-2">
      {ok ? <Check size={16} className="text-emerald-600" /> : <X size={16} className="text-ink-faint" />}
      <span className={ok ? '' : 'text-ink-muted'}>{label}</span>
    </li>
  );

  return (
    <section className="card mb-6 animate-appear border-brand/30 p-5 sm:p-6">
      <h2 className="flex items-center gap-2 font-display text-lg font-medium">
        <Wrench size={18} className="text-brand" /> Finish connecting Twilio
      </h2>

      {result ? (
        <div className="mt-4 space-y-4 text-[15px]">
          <p>Done. Add these two values to Netlify (Site configuration → Environment variables), then redeploy the site:</p>
          <div className="space-y-2">
            <CopyRow name="TWILIO_TWIML_APP_SID" value={result.twimlAppSid} />
            <CopyRow name="TWILIO_INTELLIGENCE_SERVICE_SID" value={result.intelligenceServiceSid} />
          </div>
          <details className="text-sm text-ink-muted">
            <summary className="cursor-pointer">What was set up</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {result.log.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-[15px]">
          <ul className="space-y-1.5 text-sm">
            {item(s.keys, 'Account SID and API key in Netlify')}
            {item(s.authToken, 'Auth Token in Netlify')}
            {item(s.twimlApp, 'TWILIO_TWIML_APP_SID (calling)')}
            {item(s.intelligence, 'TWILIO_INTELLIGENCE_SERVICE_SID (transcripts)')}
          </ul>
          {s.keys ? (
            <>
              <p className="text-sm text-ink-muted">
                Setup creates the calling app and transcript service on your Twilio account and points your numbers' voicemail and texts at{' '}
                <b className="text-ink">{s.siteUrl}</b>. Run it from your live dialer address. It's safe to run again.
              </p>
              <Button onClick={run} disabled={running}>
                {running ? <Spinner /> : <Wrench size={16} />} Finish Twilio setup
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Add TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET to Netlify and redeploy first.</p>
          )}
          {!s.authToken && s.keys && <p className="text-sm text-amber-700">Also add TWILIO_AUTH_TOKEN: it's needed to check that call events really come from Twilio.</p>}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

function CopyRow({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-neutral-50 px-4 py-2.5">
      <code className="text-sm font-medium">{name}</code>
      <code className="text-sm text-ink-muted">=</code>
      <code className="break-all text-sm">{value}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy value'}
      </button>
    </div>
  );
}
