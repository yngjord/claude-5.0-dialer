import { Check, FileText, Pencil } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { renderScript, type ScriptContext } from '../../shared/script';
import type { Script } from '../../shared/types';
import { must, useLoad } from '../lib/api';
import { formatDate } from '../lib/format';
import { supabase } from '../lib/supabase';

/**
 * A script filled in for this call. Variables with no value stay as {{name}} on amber, so the rep notices; {{answer}}
 * is a red "Prospect answers" pause.
 */
export function ScriptText({ body, ctx }: { body: string; ctx: ScriptContext }) {
  return (
    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-soft">
      {renderScript(body, ctx).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === 'answer' ? (
          <span key={i} className="mx-0.5 inline-flex items-center rounded-full bg-red-600 px-2.5 py-0.5 align-middle text-xs font-semibold uppercase tracking-wide text-white" title="Pause: let the prospect answer">
            Prospect answers
          </span>
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
 * clients with several can switch. Admins can edit it in place: click the text, change it, click away to save.
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
  const { isAdmin } = useAuth();

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
        isAdmin ? (
          <EditableScript key={script.id} script={script} ctx={ctx} onSaved={() => scripts.reload({ quiet: true })} />
        ) : (
          <ScriptText body={script.body} ctx={ctx} />
        )
      ) : (
        <p className="text-sm text-ink-muted">There's no script for this client yet. Admins add scripts when creating or editing a campaign.</p>
      )}
    </section>
  );
}

/**
 * Admins only (RLS lets only admins change scripts): the script as the rep sees it until clicked, then the raw text
 * with its {{variables}} to edit. Clicking away saves; Esc puts it back as it was. Every rep on this client's
 * campaigns gets the change on their next contact.
 */
function EditableScript({ script, ctx, onSaved }: { script: Script; ctx: ScriptContext; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(script.body);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setText(script.body);
  }, [script.body, editing]);
  // Grow with the text, so the whole script stays visible while editing.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, editing]);

  const save = async () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setText(script.body);
      return;
    }
    if (text === script.body) return;
    if (!text.trim()) {
      setText(script.body);
      setError('A script can’t be empty, so it was left as it was.');
      setState('error');
      return;
    }
    setState('saving');
    setError(null);
    const { error: err } = await supabase.from('dialer_scripts').update({ body: text }).eq('id', script.id);
    if (err) {
      setState('error');
      setError(`Couldn’t save: ${err.message}`);
      return;
    }
    setState('saved');
    onSaved();
    setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2500);
  };

  return (
    <div>
      {editing ? (
        <>
          <textarea
            ref={area}
            autoFocus
            aria-label="Edit script"
            className="field w-full resize-none font-mono text-[14px] leading-relaxed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelled.current = true;
                area.current?.blur();
              }
            }}
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            Click away to save, Esc to cancel. Use {'{{first_name}}'}, {'{{company}}'} and the like for details, and {'{{answer}}'} where the prospect answers.
          </p>
        </>
      ) : (
        <div
          role="button"
          tabIndex={0}
          title="Click to edit the script (admins only)"
          onClick={() => setEditing(true)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), setEditing(true))}
          className="-m-2 cursor-text rounded-xl p-2 outline-none ring-brand/30 transition hover:bg-brand-tint/40 focus-visible:ring-2"
        >
          <ScriptText body={text} ctx={ctx} />
        </div>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
        {state === 'saving' ? (
          'Saving…'
        ) : state === 'saved' ? (
          <span className="flex items-center gap-1 text-emerald-700">
            <Check size={13} /> Saved for everyone on {script.client_name}’s campaigns
          </span>
        ) : state === 'error' ? (
          <span className="text-red-700">{error}</span>
        ) : !editing ? (
          <>
            <Pencil size={12} /> Admins: click the script to edit it
          </>
        ) : null}
      </p>
    </div>
  );
}
