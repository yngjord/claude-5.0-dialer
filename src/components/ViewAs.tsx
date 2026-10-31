import { Eye, LogOut } from 'lucide-react';
import { useState } from 'react';
import type { DialerUser } from '../../shared/types';
import { useAuth } from '../auth/AuthProvider';
import { must, useLoad } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Avatar } from './Avatar';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

/** Across the top of every page while an admin is viewing as a team member, with the way back. */
export function ViewAsBanner() {
  const { viewingAs, backToAdmin } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!viewingAs) return null;
  return (
    <div role="status" className="sticky top-0 z-[60] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-400 px-4 py-2 text-sm text-amber-950">
      <Eye size={16} className="shrink-0" />
      <span>
        Viewing as <b>{viewingAs.name}</b>. Calls and changes you make are saved as them.
      </span>
      <button
        onClick={() => {
          setBusy(true);
          backToAdmin().finally(() => setBusy(false));
        }}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-50 hover:bg-black disabled:opacity-60"
      >
        {busy ? <Spinner size={12} /> : <LogOut size={13} />} Back to {viewingAs.adminName}
      </button>
    </div>
  );
}

/** Sidebar (admins): pick a team member to view the dialer as. */
export function ViewAsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="mt-2 flex w-full items-center justify-center gap-2 rounded-full border border-white/25 py-1.5 text-xs font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white">
        <Eye size={14} /> View as team member
      </button>
      {open && <ViewAsModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ViewAsModal({ onClose }: { onClose: () => void }) {
  const { viewAs } = useAuth();
  const users = useLoad(async () => (must(await supabase.rpc('dialer_users')) as DialerUser[]).filter((u) => u.role === 'team'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (u: DialerUser) => {
    setBusy(u.id);
    setError(null);
    try {
      await viewAs(u.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch.');
      setBusy(null);
    }
  };

  return (
    <Modal title="View as a team member" onClose={busy ? () => undefined : onClose}>
      <p className="mb-4 text-sm text-ink-muted">
        See the dialer exactly as they do: their campaigns, calls, leads and callbacks. Anything you do, including calls, is saved as them. A bar at the top takes you back to your admin login.
      </p>
      {users.loading ? (
        <div className="skeleton h-12 w-full" />
      ) : users.error ? (
        <p className="text-sm text-red-600">{users.error}</p>
      ) : !users.data?.length ? (
        <p className="text-sm text-ink-muted">There are no team members yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {users.data.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2.5">
              <Avatar url={undefined} name={u.display_name || u.email} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{u.display_name || u.email}</p>
                <p className="truncate text-xs text-ink-muted">{u.email}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => pick(u)} disabled={!!busy}>
                {busy === u.id ? <Spinner /> : <Eye size={14} />} View as
              </Button>
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
