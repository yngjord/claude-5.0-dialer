import { BarChart3, Inbox as InboxIcon, LayoutList, LogOut, Menu, PhoneCall, Settings2, Smartphone, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useInboxCount } from '../lib/useInboxCount';
import { useVoice } from '../voice/VoiceProvider';
import Brand from './Brand';
import { ClickToCallBar } from './ClickToCall';
import LoadingBar from './LoadingBar';

// Team members only get Campaigns and Stats; the rest is for admins.
const NAV: { to: string; label: string; icon: LucideIcon; adminOnly?: boolean }[] = [
  { to: '/campaigns', label: 'Campaigns', icon: LayoutList },
  { to: '/calls', label: 'Calls', icon: PhoneCall, adminOnly: true },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, adminOnly: true },
  { to: '/stats', label: 'Stats', icon: BarChart3 },
];
const ADMIN_NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/admin/campaigns', label: 'Manage campaigns', icon: Settings2 },
  { to: '/admin/numbers', label: 'Phone numbers', icon: Smartphone },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-xl px-4 py-3 text-[16px] font-medium transition-colors ${isActive ? 'bg-white/20' : 'text-white/85 hover:bg-white/10 hover:text-white'}`;

function PhoneStatus() {
  const { deviceState, deviceError, start } = useVoice();
  const label = { off: 'Phone off', starting: 'Connecting…', ready: 'Phone ready', error: 'Phone error' }[deviceState];
  const dot = { off: 'bg-white/40', starting: 'bg-amber-300', ready: 'bg-emerald-400', error: 'bg-red-400' }[deviceState];
  return (
    <button
      onClick={() => start().catch(() => undefined)}
      disabled={deviceState === 'ready' || deviceState === 'starting'}
      title={deviceError ?? (deviceState === 'off' ? 'Turn on the phone (asks for your microphone)' : undefined)}
      className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-left text-xs text-white/80 enabled:hover:text-white"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      {label}
      {deviceState === 'off' && <span className="ml-auto underline">Turn on</span>}
      {deviceState === 'error' && <span className="ml-auto underline">Retry</span>}
    </button>
  );
}

export default function AppShell() {
  const { me, error, signOut, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const unread = useInboxCount(isAdmin ? me?.userId : undefined);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  const badge = (to: string) =>
    to === '/inbox' && unread > 0 ? (
      <span className="ml-auto rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink" aria-label={`${unread} unread`}>
        {unread}
      </span>
    ) : null;

  return (
    <div className="min-h-screen">
      <LoadingBar />

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between bg-brand px-4 lg:hidden">
        <NavLink to="/campaigns" aria-label="Maronly dialer home">
          <Brand tone="light" />
        </NavLink>
        <button className="relative flex h-10 w-10 items-center justify-center rounded-xl text-white hover:bg-white/10" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu size={22} />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-400" />}
        </button>
      </header>

      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <aside className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-brand text-white transition-transform duration-300 ease-out lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-20 items-center justify-between px-6">
          <NavLink to="/campaigns" aria-label="Maronly dialer home">
            <Brand tone="light" />
          </NavLink>
          <button className="flex h-9 w-9 items-center justify-center rounded-xl hover:bg-white/10 lg:hidden" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <p className="-mt-3 mb-2 px-6 text-xs font-medium uppercase tracking-[0.18em] text-white/60">Dialer</p>

        <nav aria-label="Main" className="mt-2 flex-1 space-y-1.5 overflow-y-auto px-3">
          {NAV.filter((n) => isAdmin || !n.adminOnly).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={navClass}>
              <Icon size={20} strokeWidth={1.75} />
              {label}
              {badge(to)}
            </NavLink>
          ))}
          {isAdmin && (
            <>
              <p className="px-4 pb-1 pt-5 text-xs text-white/60">Admin</p>
              {ADMIN_NAV.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className={navClass}>
                  <Icon size={20} strokeWidth={1.75} />
                  {label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="m-3 rounded-2xl bg-white/10 p-4">
          <PhoneStatus />
          <p className="mt-3 flex items-center gap-2 text-xs text-white/70">
            Logged in as
            {me && <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">{me.role === 'admin' ? 'Admin' : 'Team'}</span>}
          </p>
          <p className="mt-0.5 truncate font-medium" title={me?.email}>
            {me?.displayName ?? '…'}
          </p>
          <button onClick={signOut} className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-white/15 py-2 text-sm font-medium transition-colors hover:bg-white/25">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>

      <main className="px-4 pb-16 pt-6 sm:px-6 lg:ml-64 lg:px-10 lg:pt-10">
        <div className="mx-auto max-w-[1200px]">
          <ClickToCallBar />
          {error ? (
            <div className="card mx-auto max-w-lg p-8 text-center">
              <h1 className="font-display text-xl">We couldn't load your account</h1>
              <p className="mt-3 text-ink-muted">{error}</p>
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}
