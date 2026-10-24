import { FileUp } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  buildImport,
  columnCustomKey,
  CONTACT_FIELD_LABELS,
  CONTACT_FIELDS,
  guessMapping,
  headerKey,
  parseCsv,
  type ColumnMapping,
  type ColumnTarget,
  type CustomField,
  type ImportRowIssue,
} from '../../shared/csv';
import { toCsv, downloadCsv } from '../lib/csv';
import { supabase } from '../lib/supabase';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

const BATCH = 500;

/** Which of these numbers the campaign's client already has as contacts, in any of its campaigns. */
async function existingPhones(campaignId: string, phones: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < phones.length; i += 1000) {
    const { data, error } = await supabase.rpc('dialer_existing_phones', { p_campaign_id: campaignId, p_phones: phones.slice(i, i + 1000) });
    if (error) throw new Error(error.message);
    (data as string[]).forEach((p) => found.add(p));
  }
  return found;
}

// <select> values for a column target: "field:phone", "custom:industry", "new", "skip".
const targetValue = (t: ColumnTarget) => (t.kind === 'field' ? `field:${t.field}` : t.kind === 'custom' ? `custom:${t.key}` : t.kind);
function parseTarget(value: string, header: string): ColumnTarget {
  if (value.startsWith('field:')) return { kind: 'field', field: value.slice(6) as (typeof CONTACT_FIELDS)[number] };
  if (value.startsWith('custom:')) return { kind: 'custom', key: value.slice(7) };
  if (value === 'new') return { kind: 'new', label: header.trim() };
  return { kind: 'skip' };
}

/**
 * CSV upload → map columns → check numbers → add to the campaign. Numbers repeated in the file or already a contact
 * for this client (in any of its campaigns) are flagged, and left out unless the user unticks "Remove duplicates".
 * Extra columns become saved custom fields; the headers used are remembered so the next file maps itself.
 */
export function ImportModal({ campaignId, onClose, onImported }: { campaignId: string; onClose: () => void; onImported: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [dedupe, setDedupe] = useState(true);
  const [dragging, setDragging] = useState(false);

  // While this is open, a file dropped anywhere outside the drop box is ignored instead of the browser opening or
  // downloading it.
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const hasPhone = mapping.some((t) => t.kind === 'field' && t.field === 'phone');
  // The client's existing contacts, looked up for the numbers in the column mapped as the phone.
  const phonesKey = useMemo(() => (rows && hasPhone ? [...new Set(buildImport(rows, mapping).valid.map((c) => c.phone_e164))].join(',') : null), [rows, mapping, hasPhone]);
  useEffect(() => {
    setExisting(phonesKey === '' ? new Set() : null);
    if (!phonesKey) return;
    let cancelled = false;
    existingPhones(campaignId, phonesKey.split(','))
      .then((found) => !cancelled && setExisting(found))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not check for duplicates.'));
    return () => {
      cancelled = true;
    };
  }, [phonesKey, campaignId]);

  const preview = useMemo(() => (rows && existing && hasPhone ? buildImport(rows, mapping, existing) : null), [rows, mapping, existing, hasPhone]);
  const toImport = preview ? (dedupe ? preview.unique : preview.valid) : null;
  const newFields = new Set(mapping.flatMap((t) => (t.kind === 'new' ? [columnCustomKey(t)!] : [])).filter((k) => !customFields.some((f) => f.key === k)));
  const blankNewField = mapping.some((t) => t.kind === 'new' && !t.label.trim());
  const setTarget = (col: number, t: ColumnTarget) => setMapping((m) => m.map((v, i) => (i === col ? t : v)));

  const onFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length < 2) throw new Error('That file has no rows under the header.');
      const { data: saved, error: fieldsError } = await supabase.from('dialer_custom_fields').select('key, label, aliases').order('label');
      if (fieldsError) throw new Error(fieldsError.message);
      setCustomFields(saved as CustomField[]);
      setRows(parsed);
      setMapping(guessMapping(parsed[0], saved as CustomField[]));
      setFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!toImport) return;
    setBusy(true);
    setError(null);
    try {
      // Save new custom fields, and remember this file's headers for the fields they were mapped to.
      const fields = mapping.flatMap((t, col) => {
        const key = columnCustomKey(t);
        if (!key) return [];
        const label = t.kind === 'new' ? t.label : (customFields.find((f) => f.key === key)?.label ?? key);
        return [{ key, label, alias: headerKey(rows?.[0][col] ?? '') }];
      });
      if (fields.length) {
        const { error } = await supabase.rpc('dialer_save_custom_fields', { p_fields: fields });
        if (error) throw new Error(error.message);
      }
      for (let i = 0; i < toImport.length; i += BATCH) {
        setProgress(i / toImport.length);
        const batch = toImport.slice(i, i + BATCH).map((c) => ({ ...c, campaign_id: campaignId, source: 'csv' }));
        const { error } = await supabase.from('dialer_contacts').insert(batch);
        if (error) throw new Error(error.message);
      }
      setDone(toImport.length);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? `Import stopped: ${err.message}` : 'Import failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const downloadRows = (suffix: string, issues: ImportRowIssue[]) =>
    downloadCsv(`${fileName?.replace(/\.csv$/i, '') ?? 'contacts'}-${suffix}.csv`, toCsv(['Row', 'Name', 'Phone', 'Reason'], issues.map((r) => [String(r.row), r.name, r.phone, r.reason])));

  return (
    <Modal
      title="Import contacts"
      onClose={busy ? () => undefined : onClose}
      size="lg"
      footer={
        done != null ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={runImport} disabled={busy || !toImport?.length || blankNewField}>
              {busy && progress != null ? (
                <>
                  <Spinner /> {Math.round(progress * 100)}%
                </>
              ) : (
                `Import ${toImport?.length.toLocaleString() ?? ''} contact${toImport?.length === 1 ? '' : 's'}`
              )}
            </Button>
          </>
        )
      }
    >
      {done != null ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">Added {done.toLocaleString()} contacts to the campaign.</p>
      ) : !rows ? (
        <label
          className={`flex cursor-pointer flex-col items-center gap-3 rounded-card border-2 border-dashed px-6 py-10 text-center transition hover:border-brand ${dragging ? 'border-brand bg-brand-tint' : 'border-line-strong'}`}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (!file || busy) return;
            if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return setError('That isn\'t a CSV file. Export the list as .csv and try again.');
            onFile(file);
          }}
        >
          {busy ? <Spinner className="text-brand" size={22} /> : <FileUp className="text-brand" size={28} />}
          <span className="font-medium">{dragging ? 'Drop the CSV here' : 'Choose a CSV file, or drag it here'}</span>
          <span className="text-sm text-ink-muted">One row per contact with a header row. Only AU and NZ mobiles can be imported.</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-ink-muted">
            {fileName} · {(rows.length - 1).toLocaleString()} rows. Match each column, then check the numbers below.
          </p>
          <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
            {rows[0].map((header, col) => (
              <div key={col} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{header || `Column ${col + 1}`}</p>
                  <p className="truncate text-xs text-ink-faint">{rows[1]?.[col]}</p>
                </div>
                <div className="flex w-56 shrink-0 flex-col gap-1.5">
                  <select aria-label={`Field for ${header}`} className="field !py-2 text-sm" value={targetValue(mapping[col])} onChange={(e) => setTarget(col, parseTarget(e.target.value, header))}>
                    <optgroup label="Contact fields">
                      {CONTACT_FIELDS.map((f) => (
                        <option key={f} value={`field:${f}`}>
                          {CONTACT_FIELD_LABELS[f]}
                        </option>
                      ))}
                    </optgroup>
                    {customFields.length > 0 && (
                      <optgroup label="Custom fields">
                        {customFields.map((f) => (
                          <option key={f.key} value={`custom:${f.key}`}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="new">New custom field…</option>
                    <option value="skip">Don't import</option>
                  </select>
                  {mapping[col].kind === 'new' && (
                    <input
                      aria-label={`Name of the new field for ${header}`}
                      className="field !py-1.5 text-sm"
                      placeholder="Field name"
                      value={(mapping[col] as { label: string }).label}
                      onChange={(e) => setTarget(col, { kind: 'new', label: e.target.value })}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          {blankNewField && <p className="text-sm text-red-600">Give each new custom field a name, or set it to Don't import.</p>}
          {newFields.size > 0 && (
            <p className="text-sm text-ink-muted">
              {newFields.size} new custom field{newFields.size === 1 ? '' : 's'} will be saved and matched automatically next time.
            </p>
          )}

          {!hasPhone ? (
            <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Choose which column holds the phone number.</p>
          ) : preview ? (
            <div className="grid grid-cols-3 gap-3 text-center">
              <Count label="Ready to import" value={toImport?.length ?? 0} tone="text-emerald-700" />
              <Count label="Duplicates" value={preview.duplicates.length} tone={preview.duplicates.length ? 'text-amber-700' : 'text-ink-muted'} />
              <Count label="Invalid numbers" value={preview.invalid.length} tone={preview.invalid.length ? 'text-red-600' : 'text-ink-muted'} />
            </div>
          ) : (
            <Spinner className="text-brand" />
          )}

          {preview && preview.duplicates.length > 0 && (
            <div className="space-y-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p>
                {preview.duplicates.length.toLocaleString()} row{preview.duplicates.length === 1 ? ' has' : 's have'} a phone number that's already in this file or already a contact for this client, e.g. row {preview.duplicates[0].row}{' '}
                ({preview.duplicates[0].name || preview.duplicates[0].phone}): {preview.duplicates[0].reason.toLowerCase()}.{' '}
                <button onClick={() => downloadRows('duplicates', preview.duplicates)} className="font-medium text-brand hover:underline">
                  Download duplicate rows
                </button>
              </p>
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                <input type="checkbox" className="h-4 w-4 accent-brand" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
                Remove duplicates (keep the first row for each number)
              </label>
            </div>
          )}

          {preview && preview.invalid.length > 0 && (
            <div className="text-sm">
              <p className="text-ink-muted">
                e.g. row {preview.invalid[0].row}: “{preview.invalid[0].phone}”: {preview.invalid[0].reason}.{' '}
                <button onClick={() => downloadRows('rejected', preview.invalid)} className="font-medium text-brand hover:underline">
                  Download rejected rows
                </button>
              </p>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </Modal>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-2xl bg-neutral-50 px-2 py-3">
      <p className={`font-display text-2xl font-medium tabular-nums ${tone}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}
