import { FileUp } from 'lucide-react';
import { useMemo, useState } from 'react';
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
} from '../../shared/csv';
import { toCsv, downloadCsv } from '../lib/csv';
import { supabase } from '../lib/supabase';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

const BATCH = 500;

async function existingPhones(campaignId: string): Promise<Set<string>> {
  const phones = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('dialer_contacts').select('phone_e164').eq('campaign_id', campaignId).range(from, from + 999);
    if (error) throw new Error(error.message);
    data.forEach((r) => phones.add(r.phone_e164 as string));
    if (data.length < 1000) return phones;
  }
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
 * CSV upload → map columns → check numbers → add to the campaign. Numbers already in the campaign are skipped.
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

  const hasPhone = mapping.some((t) => t.kind === 'field' && t.field === 'phone');
  const preview = useMemo(() => (rows && existing && hasPhone ? buildImport(rows, mapping, existing) : null), [rows, mapping, existing, hasPhone]);
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
      setExisting(await existingPhones(campaignId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
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
      for (let i = 0; i < preview.valid.length; i += BATCH) {
        setProgress(i / preview.valid.length);
        const batch = preview.valid.slice(i, i + BATCH).map((c) => ({ ...c, campaign_id: campaignId, source: 'csv' }));
        const { error } = await supabase.from('dialer_contacts').upsert(batch, { onConflict: 'campaign_id,phone_e164', ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      setDone(preview.valid.length);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? `Import stopped: ${err.message}` : 'Import failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const downloadRejected = () => {
    if (!preview) return;
    downloadCsv(`${fileName?.replace(/\.csv$/i, '') ?? 'contacts'}-rejected.csv`, toCsv(['Row', 'Name', 'Phone', 'Reason'], preview.invalid.map((r) => [String(r.row), r.name, r.phone, r.reason])));
  };

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
            <Button onClick={runImport} disabled={busy || !preview?.valid.length || blankNewField}>
              {busy && progress != null ? (
                <>
                  <Spinner /> {Math.round(progress * 100)}%
                </>
              ) : (
                `Import ${preview?.valid.length.toLocaleString() ?? ''} contact${preview?.valid.length === 1 ? '' : 's'}`
              )}
            </Button>
          </>
        )
      }
    >
      {done != null ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">Added {done.toLocaleString()} contacts to the campaign.</p>
      ) : !rows ? (
        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-card border-2 border-dashed border-line-strong px-6 py-10 text-center transition hover:border-brand">
          {busy ? <Spinner className="text-brand" size={22} /> : <FileUp className="text-brand" size={28} />}
          <span className="font-medium">Choose a CSV file</span>
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
              <Count label="Ready to import" value={preview.valid.length} tone="text-emerald-700" />
              <Count label="Already in list" value={preview.duplicates} tone="text-ink-muted" />
              <Count label="Invalid numbers" value={preview.invalid.length} tone={preview.invalid.length ? 'text-red-600' : 'text-ink-muted'} />
            </div>
          ) : (
            <Spinner className="text-brand" />
          )}

          {preview && preview.invalid.length > 0 && (
            <div className="text-sm">
              <p className="text-ink-muted">
                e.g. row {preview.invalid[0].row}: “{preview.invalid[0].phone}”: {preview.invalid[0].reason}.{' '}
                <button onClick={downloadRejected} className="font-medium text-brand hover:underline">
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
