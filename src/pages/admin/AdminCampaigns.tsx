import { Plus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatPhone } from '../../../shared/phone';
import type { AirtableClient, Campaign, DialerUser, PhoneNumber } from '../../../shared/types';
import { useAuth } from '../../auth/AuthProvider';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { api, must, useLoad } from '../../lib/api';
import { supabase } from '../../lib/supabase';

type Row = Campaign & { campaign_members: { user_id: string }[] };

export default function AdminCampaigns() {
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [members, setMembers] = useState<Row | null>(null);
  const list = useLoad(async () => must(await supabase.from('dialer_campaigns').select('*, campaign_members:dialer_campaign_members(user_id)').order('created_at', { ascending: false })) as Row[], []);
  const users = useLoad(async () => must(await supabase.rpc('dialer_users')) as DialerUser[], []);
  const numbers = useLoad(async () => must(await supabase.from('dialer_phone_numbers').select('*').order('e164')) as PhoneNumber[], []);
  const nameOf = (id: string) => {
    const u = users.data?.find((x) => x.id === id);
    return u?.display_name || u?.email || 'Unknown';
  };

  return (
    <>
      <PageHeader
        title="Manage campaigns"
        subtitle="Create call lists for a client and choose who can dial them."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> New campaign
          </Button>
        }
      />

      <section className="card animate-appear p-4 sm:p-6">
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <LoadingRows label="Loading campaigns…" />
        ) : (
          <div className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[820px]">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Campaign</th>
                  <th className="th">Client</th>
                  <th className="th">Status</th>
                  <th className="th">Caller number</th>
                  <th className="th">Team</th>
                  <th className="th">Retries</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!list.data?.length ? (
                  <EmptyRow colSpan={7}>No campaigns yet.</EmptyRow>
                ) : (
                  list.data.map((c) => (
                    <tr key={c.id}>
                      <td className="td font-medium">
                        <Link to={`/campaigns/${c.id}`} className="hover:text-brand">
                          {c.name}
                        </Link>
                      </td>
                      <td className="td">{c.client_name}</td>
                      <td className="td">
                        <Badge tone={c.status === 'active' ? 'green' : c.status === 'paused' ? 'amber' : 'grey'}>{c.status}</Badge>
                      </td>
                      <td className="td tabular-nums text-ink-muted">
                        {c.caller_number_id ? formatPhone(numbers.data?.find((n) => n.id === c.caller_number_id)?.e164) : "Each rep's own"}
                      </td>
                      <td className="td max-w-[240px]">
                        <button onClick={() => setMembers(c)} className="inline-flex max-w-full items-center gap-1.5 truncate text-brand hover:underline">
                          <Users size={15} className="shrink-0" />
                          <span className="truncate">{c.campaign_members.length ? c.campaign_members.map((m) => nameOf(m.user_id)).join(', ') : 'Assign people'}</span>
                        </button>
                      </td>
                      <td className="td text-ink-muted">
                        {c.max_attempts} dials, every {Math.round(c.retry_after_minutes / 60)}h
                      </td>
                      <td className="td text-right">
                        <Button variant="ghost" onClick={() => setEditing(c)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <CampaignForm
          campaign={editing === 'new' ? null : editing}
          numbers={numbers.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload({ quiet: true });
          }}
        />
      )}
      {members && (
        <MembersModal
          campaign={members}
          users={users.data ?? []}
          onClose={() => setMembers(null)}
          onSaved={() => {
            setMembers(null);
            list.reload({ quiet: true });
          }}
        />
      )}
    </>
  );
}

function CampaignForm({ campaign, numbers, onClose, onSaved }: { campaign: Campaign | null; numbers: PhoneNumber[]; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const clients = useLoad(() => api<AirtableClient[]>('clients'), []);
  const [name, setName] = useState(campaign?.name ?? '');
  const [clientId, setClientId] = useState(campaign?.airtable_client_id ?? '');
  const [numberId, setNumberId] = useState(campaign?.caller_number_id ?? '');
  const [status, setStatus] = useState<Campaign['status']>(campaign?.status ?? 'active');
  const [maxAttempts, setMaxAttempts] = useState(String(campaign?.max_attempts ?? 3));
  const [retryHours, setRetryHours] = useState(String((campaign?.retry_after_minutes ?? 1440) / 60));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const client = clients.data?.find((c) => c.id === clientId);
    if (!name.trim()) return setError('Give the campaign a name.');
    if (!client) return setError('Choose the client.');
    const attempts = Number(maxAttempts);
    const minutes = Math.round(Number(retryHours) * 60);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) return setError('Max dials must be between 1 and 20.');
    if (!Number.isFinite(minutes) || minutes < 5) return setError('Retry delay must be at least 5 minutes.');

    setSaving(true);
    setError(null);
    const fields = {
      name: name.trim(),
      client_name: client.name,
      airtable_client_id: client.id,
      caller_number_id: numberId || null,
      status,
      max_attempts: attempts,
      retry_after_minutes: minutes,
    };
    const { error } = campaign
      ? await supabase.from('dialer_campaigns').update(fields).eq('id', campaign.id)
      : await supabase.from('dialer_campaigns').insert({ ...fields, created_by: me?.userId });
    setSaving(false);
    if (error) return setError(error.message);
    onSaved();
  };

  return (
    <Modal
      title={campaign ? 'Edit campaign' : 'New campaign'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="campaign-form" disabled={saving}>
            {saving && <Spinner />} Save
          </Button>
        </>
      }
    >
      <form id="campaign-form" onSubmit={save} className="space-y-4" noValidate>
        <div>
          <label htmlFor="c-name" className="mb-2 block text-sm font-medium text-ink-soft">
            Name
          </label>
          <input id="c-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kintell – HR leaders Oct" />
        </div>
        <div>
          <label htmlFor="c-client" className="mb-2 block text-sm font-medium text-ink-soft">
            Client (Airtable)
          </label>
          <select id="c-client" className="field" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={clients.loading}>
            <option value="">{clients.loading ? 'Loading clients…' : 'Choose…'}</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status ? ` (${c.status})` : ''}
              </option>
            ))}
          </select>
          {clients.error && <p className="mt-1.5 text-sm text-red-600">{clients.error}</p>}
          <p className="mt-1.5 text-xs text-ink-faint">Calls show in this client's Cold Call Logs in the portal, and Leads are linked to them.</p>
        </div>
        <div>
          <label htmlFor="c-number" className="mb-2 block text-sm font-medium text-ink-soft">
            Caller number
          </label>
          <select id="c-number" className="field" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
            <option value="">Each rep's own number</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {formatPhone(n.e164)} {n.label ? `· ${n.label}` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-ink-faint">Used when the rep has no number of their own.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="c-attempts" className="mb-2 block text-sm font-medium text-ink-soft">
              Max dials per contact
            </label>
            <input id="c-attempts" type="number" min={1} max={20} className="field" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
          </div>
          <div>
            <label htmlFor="c-retry" className="mb-2 block text-sm font-medium text-ink-soft">
              Retry no-answers after (hours)
            </label>
            <input id="c-retry" type="number" min={0.1} step={0.5} className="field" value={retryHours} onChange={(e) => setRetryHours(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="c-status" className="mb-2 block text-sm font-medium text-ink-soft">
            Status
          </label>
          <select id="c-status" className="field" value={status} onChange={(e) => setStatus(e.target.value as Campaign['status'])}>
            <option value="active">Active</option>
            <option value="paused">Paused (no dialing)</option>
            <option value="archived">Archived (hidden)</option>
          </select>
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function MembersModal({ campaign, users, onClose, onSaved }: { campaign: Row; users: DialerUser[]; onClose: () => void; onSaved: () => void }) {
  const [selected, setSelected] = useState(() => new Set(campaign.campaign_members.map((m) => m.user_id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const before = new Set(campaign.campaign_members.map((m) => m.user_id));
    const add = [...selected].filter((id) => !before.has(id));
    const remove = [...before].filter((id) => !selected.has(id));
    try {
      if (add.length) must(await supabase.from('dialer_campaign_members').insert(add.map((user_id) => ({ campaign_id: campaign.id, user_id }))));
      if (remove.length) must(await supabase.from('dialer_campaign_members').delete().eq('campaign_id', campaign.id).in('user_id', remove));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Who can dial ${campaign.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner />} Save
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-ink-muted">Admins can dial every campaign. Team members only see the ones they're ticked for here.</p>
      <ul className="divide-y divide-line">
        {users.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-3 py-3">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand"
                checked={u.role === 'admin' || selected.has(u.id)}
                disabled={u.role === 'admin'}
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{u.display_name || u.email}</span>
                {u.display_name && <span className="block truncate text-xs text-ink-muted">{u.email}</span>}
              </span>
              {u.role === 'admin' && <Badge tone="blue">Admin</Badge>}
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
