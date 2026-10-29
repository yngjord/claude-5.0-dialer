import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { renderScript, type ScriptContext } from '../../shared/script';
import type { Script } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import { formatDate } from '../lib/format';
import { supabase } from '../lib/supabase';

/** A script filled in for this call. Variables with no value stay as {{name}} on amber, so the rep notices. */
export function ScriptText({ body, ctx }: { body: string; ctx: ScriptContext }) {
  return (
    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-soft">
      {renderScript(body, ctx).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === 'value' ? (
          <span key={i} className="font-medium text-ink" title={`{{${part.key}}}`}>
            {part.text}
          </span>
        ) : (
          <span key={i} className="rounded bg-amber-100 px-1 text-amber-900" title="No value for this contact">
            {part.text}
          </span>
        ),
      )}
    </p>
  );
}

/**
 * Power dialer: the client's call script, filled in for the contact on screen. Starts on the campaign's script;
 * clients with several can switch.
 */
export function ScriptPanel({ clientId, defaultScriptId, ctx }: { clientId: string; defaultScriptId: string | null; ctx: ScriptContext }) {
  const scripts = useLoad(
    async () => must(await supabase.from('dialer_scripts').select('*').eq('airtable_client_id', clientId).order('name')) as Script[],
    [clientId],
  );
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [clientId]);
  const list = scripts.data ?? [];
  const script = list.find((s) => s.id === picked) ?? list.find((s) => s.id === defaultScriptId) ?? list[0];

  return (
    <section className="card p-5 sm:p-6" aria-label="Call script">
      <div className="mb-4 flex items-center gap-2">
        <FileText size={17} className="shrink-0 text-brand" />
        {list.length > 1 ? (
          <select aria-label="Script" className="field !py-1.5 text-sm" value={script?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · created {formatDate(s.created_at)}
              </option>
            ))}
          </select>
        ) : (
          <p className="min-w-0 truncate">
            <span className="font-display text-[15px] font-medium">{script?.name ?? 'Script'}</span>
            {script && <span className="ml-2 text-xs text-ink-muted">created {formatDate(script.created_at)}</span>}
          </p>
        )}
      </div>
      {scripts.loading ? (
        <div className="space-y-2">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-5/6" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      ) : scripts.error ? (
        <p className="text-sm text-red-600">{scripts.error}</p>
      ) : script ? (
        <ScriptText body={script.body} ctx={ctx} />
      ) : (
        <p className="text-sm text-ink-muted">There's no script for this client yet. Admins add scripts when creating or editing a campaign.</p>
      )}
    </section>
  );
}
