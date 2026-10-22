import { AlertTriangle, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { formatPhone } from '../../../shared/phone';
import type { AirtableClient, AvailableNumbersResponse, BuyNumberRequest, PhoneNumber } from '../../../shared/types';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { api, useLoad } from '../../lib/api';

const BUNDLE_STATUS: Record<string, string> = {
  draft: 'still a draft',
  'pending-review': 'waiting for review',
  'in-review': 'being reviewed',
  'twilio-rejected': 'rejected. Check the reason in Twilio',
};

const money = (p: { amount: number; currency: string }) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: p.currency }).format(p.amount);

/**
 * Buy an AU mobile number on the Twilio account for a client. Two steps: pick a number and client, then confirm the
 * monthly cost. The number's voicemail/SMS webhooks are set up and it's added to the list.
 */
export function BuyNumberModal({ onClose, onBought }: { onClose: () => void; onBought: (n: PhoneNumber) => void }) {
  const [contains, setContains] = useState('');
  const [query, setQuery] = useState('');
  const results = useLoad(() => api<AvailableNumbersResponse>(`admin/numbers/available${query ? `?contains=${encodeURIComponent(query)}` : ''}`), [query]);
  const clients = useLoad(() => api<AirtableClient[]>('clients'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [clientName, setClientName] = useState('');
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = results.data;
  const canContinue = !!selected && !!clientName && !!data?.bundleReady;

  const search = (e: FormEvent) => {
    e.preventDefault();
    setSelected(null);
    setQuery(contains.replace(/\D/g, ''));
  };

  const buy = async () => {
    if (!selected) return;
    setBuying(true);
    setError(null);
    try {
      const body: BuyNumberRequest = { phoneNumber: selected, clientName, label: label || null };
      onBought(await api<PhoneNumber>('admin/numbers/buy', { method: 'POST', body: JSON.stringify(body) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not buy the number.');
      setBuying(false);
      setConfirming(false);
    }
  };

  if (confirming && selected) {
    return (
      <Modal
        title="Buy this number?"
        onClose={buying ? () => undefined : () => setConfirming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={buying}>
              Back
            </Button>
            <Button onClick={buy} disabled={buying}>
              {buying && <Spinner />} Buy number
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[15px]">
          <p>
            <b className="tabular-nums">{formatPhone(selected)}</b> for <b>{clientName}</b>
            {label ? ` (${label})` : ''}.
          </p>
          <p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-ink-muted">
            Twilio charges {data?.price ? <b className="text-ink">{money(data.price)} a month</b> : 'a monthly fee'} for this number, plus usage, until it's released in
            Twilio. Calls and texts for {clientName}'s campaigns will use it straight away.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Buy a number"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => setConfirming(true)} disabled={!canContinue}>
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-ink-muted">
          Australian mobile numbers (calls and texts)
          {data?.price ? `, ${money(data.price)} a month each` : ''}. Give each client their own number.
        </p>

        {data && !data.bundleReady && (
          <p className="flex gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              You can browse numbers, but can't buy until Twilio approves your Australian regulatory bundle
              {data.bundleStatus ? ` (it's ${BUNDLE_STATUS[data.bundleStatus] ?? data.bundleStatus})` : ''}.
            </span>
          </p>
        )}

        <form onSubmit={search} className="flex gap-2">
          <label htmlFor="contains" className="sr-only">
            Digits to search for
          </label>
          <input id="contains" className="field" inputMode="numeric" placeholder="Digits to look for, e.g. 0400 or 888 (optional)" value={contains} onChange={(e) => setContains(e.target.value)} />
          <Button type="submit" variant="outline" className="!h-auto">
            <Search size={16} /> Search
          </Button>
        </form>

        {results.error ? (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {results.error}
          </p>
        ) : results.loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-muted">
            <Spinner className="text-brand" /> Looking up numbers…
          </div>
        ) : !data?.numbers.length ? (
          <p className="py-6 text-center text-sm text-ink-faint">No numbers found{query ? ' with those digits' : ''}. Try different digits.</p>
        ) : (
          <fieldset className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
            <legend className="sr-only">Available numbers</legend>
            {data.numbers.map((n) => (
              <label
                key={n.phoneNumber}
                className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-2.5 transition ${selected === n.phoneNumber ? 'border-brand bg-brand-tint' : 'border-line-strong hover:border-brand'}`}
              >
                <input type="radio" name="number" className="accent-brand" checked={selected === n.phoneNumber} onChange={() => setSelected(n.phoneNumber)} />
                <span className="font-medium tabular-nums">{formatPhone(n.phoneNumber)}</span>
                <span className="ml-auto text-xs text-ink-muted">{[n.locality, n.region].filter(Boolean).join(', ')}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="buy-client" className="mb-2 block text-sm font-medium text-ink-soft">
              Client
            </label>
            <select id="buy-client" className="field" value={clientName} onChange={(e) => setClientName(e.target.value)} disabled={clients.loading}>
              <option value="">{clients.loading ? 'Loading clients…' : 'Choose…'}</option>
              {clients.data?.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="buy-label" className="mb-2 block text-sm font-medium text-ink-soft">
              Label <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <input id="buy-label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Kintell main" />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
