import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ANSWER_KEY, SCRIPT_VARIABLES, type ScriptContext } from '../../../shared/script';
import type { Script } from '../../../shared/types';
import { ScriptText } from '../../components/ScriptView';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../auth/AuthProvider';
import { must, useLoad } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { supabase } from '../../lib/supabase';

// A made-up contact, so the editor can show the script as a rep will read it.
const SAMPLE: ScriptContext['contact'] = {
  full_name: 'Sam Taylor',
  first_name: 'Sam',
  company: 'Acme',
  title: 'Head of Marketing',
  email: 'sam@acme.com',
  website: 'https://www.acme.com',
  custom: {},
};

/**
 * Admin: a client's call scripts (create, edit, delete), opened from the campaign form. Calls `onClose` with the
 * client's scripts as they now are, so the form's script picker stays current.
 */
export function ScriptsModal({ clientId, clientName, onClose }: { clientId: string; clientName: string; onClose: (scripts: Script[]) => void }) {
  const { me } = useAuth();
  const scripts = useLoad(
    async () => must(await supabase.from('dialer_scripts').select('*').eq('airtable_client_id', clientId).order('name')) as Script[],
    [clientId],
  );
  const customFields = useLoad(async () => must(await supabase.from('dialer_custom_fields').select('key, label').order('label')) as { key: string; label: string }[], []);
  const [editing, setEditing] = useState<Script | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Script | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const close = () => onClose(scripts.data ?? []);
  const edit = (s: Script | 'new') => {
    setEditing(s);
    setName(s === 'new' ? '' : s.name);
    setBody(s === 'new' ? '' : s.body);
    setError(null);
  };

  // Inserts {{key}} where the cursor is in the script. The answer pause goes on a line of its own.
  const insert = (key: string) => {
    const el = bodyRef.current;
    const at = el ? el.selectionStart : body.length;
    const end = el ? el.selectionEnd : body.length;
    const ownLine = key === ANSWER_KEY;
    const token = `${ownLine && at > 0 && body[at - 1] !== '\n' ? '\n' : ''}{{${key}}}${ownLine && body[end] !== '\n' ? '\n' : ''}`;
    setBody(body.slice(0, at) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = async () => {
    if (!name.trim()) return setError('Give the script a name.');
    setSaving(true);
    setError(null);
    try {
      if (editing === 'new') {
        must(await supabase.from('dialer_scripts').insert({ airtable_client_id: clientId, client_name: clientName, name: name.trim(), body, created_by: me?.userId }));
      } else if (editing) {
        must(await supabase.from('dialer_scripts').update({ name: name.trim(), body, client_name: clientName }).eq('id', editing.id));
      }
      await scripts.reload({ quiet: true });
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the script.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Script) => {
    setSaving(true);
    setError(null);
    try {
      must(await supabase.from('dialer_scripts').delete().eq('id', s.id));
      await scripts.reload({ quiet: true });
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the script.');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const variables = [...SCRIPT_VARIABLES, ...(customFields.data ?? []).filter((f) => !SCRIPT_VARIABLES.some((v) => v.key === f.key))];
    return (
      <Modal
        title={editing === 'new' ? `New script for ${clientName}` : `Edit ${editing.name}`}
        size="lg"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => setEditing(null)} disabled={saving}>
              <ArrowLeft size={15} /> Back
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Spinner />} Save script
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="s-name" className="mb-2 block text-sm font-medium text-ink-soft">
              Name
            </label>
            <input id="s-name" autoFocus className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Opener – testimonial videos" />
          </div>
          <div>
            <label htmlFor="s-body" className="mb-2 block text-sm font-medium text-ink-soft">
              Script
            </label>
            <textarea
              id="s-body"
              ref={bodyRef}
              rows={10}
              className="field resize-y font-body text-[15px] leading-relaxed"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"Hi {{first_name}}, it's {{agent_first_name}} calling from {{client_name}}…"}
            />
            <p className="mb-1.5 mt-2 text-xs text-ink-muted">Insert a detail (filled in for each contact when the rep calls):</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => insert(ANSWER_KEY)}
                className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
                title="A pause where the prospect answers: {{answer}}"
              >
                Prospect answers
              </button>
              {variables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insert(v.key)}
                  className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-soft hover:border-brand hover:text-brand"
                  title={`{{${v.key}}}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
          {body.trim() && (
            <div className="rounded-2xl bg-neutral-50 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">Preview (sample contact)</p>
              <ScriptText body={body} ctx={{ contact: SAMPLE, agentName: me?.displayName ?? 'You', clientName, campaignName: 'This campaign' }} />
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`${clientName} scripts`}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button variant="outline" className="mr-auto" onClick={() => edit('new')}>
            <Plus size={15} /> New script
          </Button>
          <Button variant="ghost" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      {scripts.loading ? (
        <div className="space-y-2">
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      ) : scripts.error ? (
        <p className="text-sm text-red-600">{scripts.error}</p>
      ) : !scripts.data?.length ? (
        <p className="text-sm text-ink-muted">No scripts for {clientName} yet. Add one, and reps on this client's campaigns can show it beside the contact while they dial.</p>
      ) : (
        <ul className="divide-y divide-line">
          {scripts.data.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {s.name} <span className="ml-1 text-xs font-normal text-ink-muted">created {formatDate(s.created_at)}</span>
                </p>
                <p className="line-clamp-2 text-sm text-ink-muted">{s.body || 'Empty script'}</p>
              </div>
              {confirmDelete?.id === s.id ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={saving}>
                    Keep
                  </Button>
                  <Button size="sm" className="!border-red-600 !bg-red-600" onClick={() => remove(s)} disabled={saving}>
                    {saving && <Spinner />} Delete
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => edit(s)} className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-black/5 hover:text-ink" aria-label={`Edit ${s.name}`}>
                    <Pencil size={15} />
                  </button>
                  <button onClick={() => setConfirmDelete(s)} className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-red-50 hover:text-red-600" aria-label={`Delete ${s.name}`}>
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </Modal>
  );
}
