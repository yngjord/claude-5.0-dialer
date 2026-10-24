import { Camera, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatPhone } from '../../../shared/phone';
import type { AirtableClient, Campaign, CampaignStats, DialerUser, PhoneNumber } from '../../../shared/types';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../../components/Avatar';
import { ClientLogo } from '../../components/ClientLogo';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyRow, ErrorState, LoadingRows, PageHeader } from '../../components/ui/States';
import { api, must, useLoad } from '../../lib/api';
import { removeAvatar, uploadAvatar, useAvatarUrls } from '../../lib/avatars';
import { useClientLogos } from '../../lib/clientLogos';
import { supabase } from '../../lib/supabase';
import { CAMPAIGN_STATUS } from '../../lib/tones';

type Row = Campaign & { campaign_members: { user_id: string }[] };

export default function AdminCampaigns() {
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [members, setMembers] = useState<Row | null>(null);
  const [rerun, setRerun] = useState<Campaign | null>(null);
  const list = useLoad(async () => must(await supabase.from('dialer_campaigns').select('*, campaign_members:dialer_campaign_members(user_id)').order('created_at', { ascending: false })) as Row[], []);
  const users = useLoad(async () => must(await supabase.rpc('dialer_users')) as DialerUser[], []);
  const avatars = useAvatarUrls(users.data);
  const logos = useClientLogos();
  const numbers = useLoad(async () => must(await supabase.from('dialer_phone_numbers').select('*').order('e164')) as PhoneNumber[], []);
  // Same order as pickCallerNumber on the server: campaign's own pick, else the client's number, else the default.
  const callerLabel = (c: Campaign) => {
    const picked = numbers.data?.find((n) => n.id === c.caller_number_id);
    if (picked) return formatPhone(picked.e164);
    const client = numbers.data?.find((n) => n.client_name === c.client_name);
    if (client) return `${formatPhone(client.e164)} (client's)`;
    const fallback = numbers.data?.find((n) => n.is_default);
    return fallback ? `${formatPhone(fallback.e164)} (default)` : 'None set up';
  };
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
                  <th className="th">Client</th>
                  <th className="th">Campaign</th>
                  <th className="th">Status</th>
                  <th className="th">Caller number</th>
                  <th className="th">Team</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!list.data?.length ? (
                  <EmptyRow colSpan={6}>No campaigns yet.</EmptyRow>
                ) : (
                  list.data.map((c) => (
                    <tr key={c.id}>
                      <td className="td">
                        <ClientLogo name={c.client_name} url={logos[c.airtable_client_id]} />
                      </td>
                      <td className="td font-medium">
                        <Link to={`/campaigns/${c.id}`} className="hover:text-brand">
                          {c.name}
                        </Link>
                      </td>
                      <td className="td">
                        <Badge tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Badge>
                      </td>
                      <td className="td tabular-nums text-ink-muted">
                        {callerLabel(c)}
                      </td>
                      <td className="td max-w-[240px]">
                        <button
                          onClick={() => setMembers(c)}
                          className="inline-flex max-w-full items-center gap-1.5 text-brand hover:underline"
                          title={c.campaign_members.map((m) => nameOf(m.user_id)).join(', ') || undefined}
                        >
                          {c.campaign_members.length ? (
                            <span className="flex -space-x-2">
                              {c.campaign_members.map((m) => (
                                <Avatar key={m.user_id} url={avatars.get(m.user_id)} name={nameOf(m.user_id)} />
                              ))}
                            </span>
                          ) : (
                            <>
                              <Users size={15} className="shrink-0" /> Assign people
                            </>
                          )}
                        </button>
                      </td>
                      <td className="td whitespace-nowrap text-right">
                        <Button variant="ghost" onClick={() => setRerun(c)} title="Make a new campaign from contacts already called">
                          <RotateCcw size={15} /> Re-run
                        </Button>
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
      {rerun && <RerunModal campaign={rerun} onClose={() => setRerun(null)} onCreated={() => list.reload({ quiet: true })} />}
      {members && (
        <MembersModal
          campaign={members}
          users={users.data ?? []}
          avatars={avatars}
          onPhotosChanged={() => users.reload({ quiet: true })}
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
  const clients = useLoad(async () => {
    const list = await api<AirtableClient[]>('clients');
    // Editing a campaign whose client has since gone inactive: keep its client selectable.
    if (campaign && !list.some((c) => c.id === campaign.airtable_client_id)) {
      list.unshift({ id: campaign.airtable_client_id, name: campaign.client_name, status: null });
    }
    return list;
  }, [campaign]);
  const [name, setName] = useState(campaign?.name ?? '');
  const [clientId, setClientId] = useState(campaign?.airtable_client_id ?? '');
  const [numberId, setNumberId] = useState(campaign?.caller_number_id ?? '');
  const [status, setStatus] = useState<Campaign['status']>(campaign?.status ?? 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // New campaigns: "Save as draft" or "Save & launch" (active). Editing: the status picked below.
  const save = async (e: FormEvent | null, newStatus?: Campaign['status']) => {
    e?.preventDefault();
    const client = clients.data?.find((c) => c.id === clientId);
    if (!name.trim()) return setError('Give the campaign a name.');
    if (!client) return setError('Choose the client.');

    setSaving(true);
    setError(null);
    const fields = {
      name: name.trim(),
      client_name: client.name,
      airtable_client_id: client.id,
      caller_number_id: numberId || null,
      status: newStatus ?? status,
    };
    const { error } = campaign
      ? await supabase.from('dialer_campaigns').update(fields).eq('id', campaign.id)
      : await supabase.from('dialer_campaigns').insert({ ...fields, created_by: me?.userId });
    setSaving(false);
    if (error) return setError(error.message);
    onSaved();
  };

  if (campaign && deleting) return <DeleteCampaignModal campaign={campaign} onCancel={() => setDeleting(false)} onDeleted={onSaved} />;

  return (
    <Modal
      title={campaign ? 'Edit campaign' : 'New campaign'}
      onClose={onClose}
      footer={
        <>
          {campaign && (
            <Button variant="ghost" className="mr-auto !text-red-600 hover:!bg-red-50" onClick={() => setDeleting(true)}>
              <Trash2 size={15} /> Delete campaign
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {campaign ? (
            <Button type="submit" form="campaign-form" disabled={saving}>
              {saving && <Spinner />} Save
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => save(null, 'draft')} disabled={saving}>
                Save as draft
              </Button>
              <Button onClick={() => save(null, 'active')} disabled={saving}>
                {saving && <Spinner />} Save &amp; launch
              </Button>
            </>
          )}
        </>
      }
    >
      <form id="campaign-form" onSubmit={(e) => save(e)} className="space-y-4" noValidate>
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
            <option value="">The client's number</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {formatPhone(n.e164)} {n.label ? `· ${n.label}` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-ink-faint">Leave as the client's number unless this campaign needs a different one. Set client numbers in Phone numbers.</p>
        </div>
        {campaign ? (
          <div>
            <label htmlFor="c-status" className="mb-2 block text-sm font-medium text-ink-soft">
              Status
            </label>
            <select id="c-status" className="field" value={status} onChange={(e) => setStatus(e.target.value as Campaign['status'])}>
              <option value="draft">Draft (only admins can see it)</option>
              <option value="active">Active</option>
              <option value="paused">Paused (the team can see it but not open or dial it)</option>
              <option value="completed">Completed</option>
            </select>
            <p className="mt-1.5 text-xs text-ink-faint">Campaigns are marked Completed automatically once every contact has been called and wrapped up.</p>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Save as a draft to set it up first (only admins can see drafts), or launch it so the team can start dialing.</p>
        )}
        {error && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/**
 * Deleting is two clicks: Delete campaign in Edit campaign, then Delete for good here. Contacts and team assignments
 * go with the campaign (cascade); call logs stay, keeping the campaign and client name, recordings and transcripts.
 */
function DeleteCampaignModal({ campaign, onCancel, onDeleted }: { campaign: Campaign; onCancel: () => void; onDeleted: () => void }) {
  const stats = useLoad(
    async () => must(await supabase.from('dialer_campaign_stats').select('contacts_total, dials_total').eq('campaign_id', campaign.id).maybeSingle()) as Pick<CampaignStats, 'contacts_total' | 'dials_total'> | null,
    [campaign.id],
  );
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    const { data, error } = await supabase.from('dialer_campaigns').delete().eq('id', campaign.id).select('id');
    if (error || !data?.length) {
      setDeleting(false);
      return setError(error?.message ?? "The campaign couldn't be deleted. Only admins can delete campaigns.");
    }
    onDeleted();
  };

  const contacts = stats.data?.contacts_total ?? 0;
  const dials = stats.data?.dials_total ?? 0;
  return (
    <Modal
      title="Delete campaign?"
      onClose={deleting ? () => undefined : onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button className="!border-red-600 !bg-red-600 hover:!bg-red-700 hover:!shadow-none" onClick={remove} disabled={deleting}>
            {deleting ? <Spinner /> : <Trash2 size={15} />} Delete for good
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[15px]">
        <p>
          This permanently deletes <b>{campaign.name}</b>
          {stats.loading ? '' : ` and its ${contacts.toLocaleString()} contact${contacts === 1 ? '' : 's'}`}, and removes everyone assigned to it. It can't be
          undone.
        </p>
        <p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-ink-muted">
          {dials > 0 ? `Its ${dials.toLocaleString()} logged call${dials === 1 ? '' : 's'} are kept` : 'Any calls made are kept'}, with their recordings and transcripts, so the
          client's Cold Call Logs and your stats don't change. To just stop dialing it, set the status to Paused or Archived instead.
        </p>
        {error && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Re-run: pick last dispositions (e.g. No Answer), name the new campaign, and the matching contacts are copied into it
 * as fresh contacts, with the same client, caller number and team. The original campaign is left as it is.
 * Do Not Call numbers are never copied.
 */
function RerunModal({ campaign, onClose, onCreated }: { campaign: Campaign; onClose: () => void; onCreated: () => void }) {
  const counts = useLoad(async () => must(await supabase.rpc('dialer_rerun_counts', { p_campaign_id: campaign.id })) as { disposition: string; contacts: number }[], [campaign.id]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['No Answer']));
  const [name, setName] = useState(`${campaign.name} – re-run`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ campaign_id: string; contacts: number; status: 'draft' | 'active' } | null>(null);

  const total = counts.data?.filter((c) => selected.has(c.disposition)).reduce((n, c) => n + c.contacts, 0) ?? 0;

  const run = async (status: 'draft' | 'active') => {
    if (!name.trim()) return setError('Give the new campaign a name.');
    setSaving(true);
    setError(null);
    try {
      const [row] = must(await supabase.rpc('dialer_rerun_campaign', { p_campaign_id: campaign.id, p_dispositions: [...selected], p_name: name.trim(), p_status: status })) as {
        campaign_id: string;
        contacts: number;
      }[];
      setMade({ ...row, status });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the campaign.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Re-run ${campaign.name}`}
      onClose={saving ? () => undefined : onClose}
      footer={
        made ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Link
              to={`/campaigns/${made.campaign_id}`}
              className="inline-flex h-10 items-center rounded-full border border-brand bg-brand px-5 text-[15px] font-medium text-white transition hover:bg-brand-hover"
            >
              Open new campaign
            </Link>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => run('draft')} disabled={saving || total === 0 || !name.trim()}>
              Save as draft
            </Button>
            <Button onClick={() => run('active')} disabled={saving || total === 0 || !name.trim()}>
              {saving ? <Spinner /> : <Plus size={15} />} Save &amp; launch
            </Button>
          </>
        )
      }
    >
      {made ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">
          Created <b>{name.trim()}</b> {made.status === 'draft' ? 'as a draft ' : ''}with {made.contacts.toLocaleString()} contact{made.contacts === 1 ? '' : 's'}, assigned to the
          same team. {campaign.name} hasn't changed.
        </p>
      ) : counts.loading ? (
        <LoadingRows label="Counting contacts…" />
      ) : counts.error ? (
        <ErrorState message={counts.error} onRetry={counts.reload} />
      ) : !counts.data?.length ? (
        <p className="text-ink-muted">No one in this campaign has been called yet.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="mb-1 text-sm font-medium text-ink-soft">1. Contacts to include, by how their last call went</p>
            <ul className="divide-y divide-line">
              {counts.data.map((c) => (
                <li key={c.disposition}>
                  <label className="flex cursor-pointer items-center gap-3 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand"
                      checked={selected.has(c.disposition)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(c.disposition);
                          else next.delete(c.disposition);
                          return next;
                        })
                      }
                    />
                    <span className="flex-1 font-medium">{c.disposition}</span>
                    <span className="tabular-nums text-ink-muted">{c.contacts.toLocaleString()}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-ink-faint">
              <b className="font-medium text-ink-soft">
                {total.toLocaleString()} contact{total === 1 ? '' : 's'}
              </b>{' '}
              will be copied into the new campaign. Do Not Call numbers are never included.
            </p>
          </div>
          <div>
            <label htmlFor="rerun-name" className="mb-2 block text-sm font-medium text-ink-soft">
              2. Name the new campaign
            </label>
            <input id="rerun-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1.5 text-xs text-ink-faint">Same client ({campaign.client_name}), caller number and team as {campaign.name}. You can change these after.</p>
          </div>
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

function MembersModal({
  campaign,
  users,
  avatars,
  onPhotosChanged,
  onClose,
  onSaved,
}: {
  campaign: Row;
  users: DialerUser[];
  avatars: Map<string, string>;
  onPhotosChanged: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const changePhoto = async (u: DialerUser, file: File | null) => {
    setPhotoBusy(u.id);
    setError(null);
    try {
      await (file ? uploadAvatar(u, file) : removeAvatar(u));
      onPhotosChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the photo.');
    } finally {
      setPhotoBusy(null);
    }
  };
  // One team member per campaign (admins can dial every campaign anyway).
  const teamIds = new Set(users.filter((u) => u.role === 'team').map((u) => u.id));
  const before = campaign.campaign_members.map((m) => m.user_id).filter((id) => teamIds.has(id));
  const [assignee, setAssignee] = useState<string | null>(before[0] ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const remove = before.filter((id) => id !== assignee);
    try {
      // Remove first: the database allows only one team member per campaign.
      if (remove.length) must(await supabase.from('dialer_campaign_members').delete().eq('campaign_id', campaign.id).in('user_id', remove));
      if (assignee && !before.includes(assignee)) must(await supabase.from('dialer_campaign_members').insert({ campaign_id: campaign.id, user_id: assignee }));
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
      <p className="mb-4 text-sm text-ink-muted">
        Pick the one team member who dials this campaign; only they will see it. Admins can dial every campaign. Use the camera button to add someone's profile picture.
      </p>
      {before.length > 1 && (
        <p className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This campaign has {before.length} team members from before. Saving keeps only the one selected below.
        </p>
      )}
      <ul className="divide-y divide-line">
        {users.map((u) => (
          <li key={u.id} className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3">
              {u.role === 'admin' ? (
                <input type="checkbox" className="h-4 w-4 accent-brand" checked disabled aria-label="Admins can dial every campaign" />
              ) : (
                <input
                  type="radio"
                  name="assignee"
                  className="h-4 w-4 accent-brand"
                  checked={assignee === u.id}
                  onChange={() => setAssignee(u.id)}
                  // Clicking the selected person again unassigns them.
                  onClick={() => assignee === u.id && setAssignee(null)}
                />
              )}
              <Avatar url={avatars.get(u.id)} name={u.display_name || u.email} size="h-9 w-9" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{u.display_name || u.email}</span>
                {u.display_name && <span className="block truncate text-xs text-ink-muted">{u.email}</span>}
              </span>
              {u.role === 'admin' && <Badge tone="blue">Admin</Badge>}
            </label>
            <div className="flex shrink-0 items-center gap-1">
              {u.avatar_url && (
                <button onClick={() => changePhoto(u, null)} disabled={photoBusy === u.id} className="rounded-full px-2 py-1 text-xs text-ink-muted hover:bg-black/[0.04] hover:text-ink">
                  Remove
                </button>
              )}
              <label
                className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line-strong text-ink-muted transition hover:border-brand hover:text-brand ${photoBusy === u.id ? 'pointer-events-none opacity-50' : ''}`}
                title={u.avatar_url ? 'Change photo' : 'Add photo'}
              >
                {photoBusy === u.id ? <Spinner /> : <Camera size={16} />}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) changePhoto(u, f);
                  }}
                />
              </label>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
