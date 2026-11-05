import { AlertTriangle, ChevronDown, Copy, Link2Off, Send } from 'lucide-react';
import { useState } from 'react';
import { invitesBroken, type ClientCalendar } from '../../../shared/calendar';
import type { AirtableClient } from '../../../shared/types';
import { useAuth } from '../../auth/AuthProvider';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { api, must, useLoad } from '../../lib/api';
import { supabase } from '../../lib/supabase';

type Row = { client: AirtableClient; cal: ClientCalendar | null };

const DEFAULTS = { invites_enabled: false, meeting_minutes: 30, title_template: '{{client}} × {{company}}', description_template: '' };

/**
 * Admin: each client's host connects their own Google Calendar from a link (no dialer login). Once connected, and
 * with invites switched on, Appointment Set sends the meeting invite from that calendar.
 */
export default function Calendars() {
  const clients = useLoad(() => api<AirtableClient[]>('clients'), []);
  const cals = useLoad(async () => must(await supabase.from('dialer_client_calendars').select('*')) as ClientCalendar[], []);
  const byId = new Map((cals.data ?? []).map((c) => [c.airtable_client_id, c]));
  const rows: Row[] = (clients.data ?? []).map((client) => ({ client, cal: byId.get(client.id) ?? null }));
  // Connected clients first, then by name.
  rows.sort((a, b) => Number(b.cal?.status === 'connected') - Number(a.cal?.status === 'connected') || a.client.name.localeCompare(b.client.name));

  return (
    <>
      <PageHeader
        title="Client calendars"
        subtitle="Send a client's host a connect link. Once their Google Calendar is connected and invites are on, Appointment Set sends the invite from their calendar."
      />
      {clients.error || cals.error ? (
        <ErrorState message={(clients.error || cals.error)!} onRetry={() => (clients.reload(), cals.reload())} />
      ) : clients.loading || cals.loading ? (
        <section className="card p-6">
          <LoadingRows label="Loading clients…" />
        </section>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <ClientCard key={r.client.id} row={r} onChanged={() => cals.reload({ quiet: true })} />
          ))}
        </div>
      )}
    </>
  );
}

function ClientCard({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const { me } = useAuth();
  const { client, cal } = row;
  const status = cal?.status ?? 'not_connected';
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    invites_enabled: cal?.invites_enabled ?? DEFAULTS.invites_enabled,
    meeting_minutes: cal?.meeting_minutes ?? DEFAULTS.meeting_minutes,
    title_template: cal?.title_template ?? DEFAULTS.title_template,
    description_template: cal?.description_template ?? DEFAULTS.description_template,
  });
  const [testEmail, setTestEmail] = useState(me?.email ?? '');

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = () =>
    run('link', async () => {
      const res = await api<{ url: string; expiresAt: string }>('admin/calendar/link', {
        method: 'POST',
        body: JSON.stringify({ airtableClientId: client.id, clientName: client.name }),
      });
      await navigator.clipboard.writeText(res.url).catch(() => undefined);
      return `Connect link copied (valid until ${new Date(res.expiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}). Send it to the person whose calendar the invites should come from. ${res.url}`;
    });

  const disconnect = () =>
    run('disconnect', async () => {
      if (!window.confirm(`Disconnect ${client.name}'s calendar? Invites stop until they connect again.`)) return;
      await api('admin/calendar/disconnect', { method: 'POST', body: JSON.stringify({ airtableClientId: client.id }) });
      return 'Disconnected, and Google access removed.';
    });

  const testInvite = () =>
    run('test', async () => {
      await api('admin/calendar/test-invite', { method: 'POST', body: JSON.stringify({ airtableClientId: client.id, email: testEmail }) });
      return `Test invite sent to ${testEmail} for tomorrow at 10am Sydney time. Delete it from the calendar afterwards.`;
    });

  const save = () =>
    run('save', async () => {
      if (!form.title_template.trim()) throw new Error('The invite title can’t be empty.');
      must(
        await supabase
          .from('dialer_client_calendars')
          .upsert({ airtable_client_id: client.id, client_name: client.name, ...form, title_template: form.title_template.trim() }, { onConflict: 'airtable_client_id' }),
      );
      return 'Saved.';
    });

  return (
    <section className="card animate-appear p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown size={20} className={`mt-1.5 shrink-0 text-ink-muted transition-transform ${open ? '' : '-rotate-90'}`} />
          <div className="min-w-0">
          <h2 className="font-display text-xl">{client.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {status === 'connected' ? (
              <>
                <Badge tone="green">Connected</Badge> {cal?.google_email ?? 'Google Calendar'}
                {cal?.invites_enabled ? <Badge tone="blue">Invites on</Badge> : <Badge tone="grey">Invites off</Badge>}
              </>
            ) : status === 'disconnected' ? (
              <>
                <Badge tone="amber">Disconnected</Badge> {cal?.last_error ?? 'Send a new connect link.'}
              </>
            ) : (
              <Badge tone="grey">Not connected</Badge>
            )}
            {invitesBroken(cal) && (
              <span className="inline-flex items-center gap-1 text-amber-800">
                <AlertTriangle size={14} /> Invites are on but won’t send
              </span>
            )}
          </p>
          </div>
        </button>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={copyLink} disabled={!!busy}>
            {busy === 'link' ? <Spinner /> : <Copy size={16} />} {status === 'connected' ? 'Copy reconnect link' : 'Copy connect link'}
          </Button>
          {status === 'connected' && (
            <Button variant="ghost" onClick={disconnect} disabled={!!busy}>
              {busy === 'disconnect' ? <Spinner /> : <Link2Off size={16} />} Disconnect
            </Button>
          )}
        </div>
      </div>

      {message && <p className="mt-4 break-all rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
      {error && (
        <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {open && (
        <div className="mt-5 space-y-4 border-t border-line pt-5">
          <label className="flex items-center gap-3 text-sm font-medium">
            <input type="checkbox" className="h-4 w-4 accent-brand" checked={form.invites_enabled} onChange={(e) => setForm({ ...form, invites_enabled: e.target.checked })} />
            Send a Google Calendar invite on Appointment Set
            {status !== 'connected' && form.invites_enabled && <span className="text-xs font-normal text-amber-700">(only once the calendar is connected)</span>}
          </label>
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <div>
              <label htmlFor={`t-${client.id}`} className="mb-2 block text-sm font-medium text-ink-soft">
                Invite title
              </label>
              <input id={`t-${client.id}`} className="field" value={form.title_template} onChange={(e) => setForm({ ...form, title_template: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`m-${client.id}`} className="mb-2 block text-sm font-medium text-ink-soft">
                Length (min)
              </label>
              <input
                id={`m-${client.id}`}
                type="number"
                min={5}
                max={240}
                step={5}
                className="field"
                value={form.meeting_minutes}
                onChange={(e) => setForm({ ...form, meeting_minutes: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`d-${client.id}`} className="mb-2 block text-sm font-medium text-ink-soft">
              Invite description (optional)
            </label>
            <textarea id={`d-${client.id}`} rows={3} className="field resize-y" value={form.description_template} onChange={(e) => setForm({ ...form, description_template: e.target.value })} />
            <p className="mt-1.5 text-xs text-ink-muted">
              Use {'{{client}}'}, {'{{company}}'}, {'{{prospect}}'} or {'{{first_name}}'}. Reps can edit the title and description before saving.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button onClick={save} disabled={!!busy}>
              {busy === 'save' ? <Spinner /> : null} Save settings
            </Button>
            {status === 'connected' && (
              <div className="flex flex-wrap items-center gap-2">
                <input className="field !h-10 !w-64" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} aria-label="Send a test invite to" />
                <Button variant="outline" onClick={testInvite} disabled={!!busy}>
                  {busy === 'test' ? <Spinner /> : <Send size={16} />} Send test invite
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

