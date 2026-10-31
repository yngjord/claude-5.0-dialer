import { LogOut } from 'lucide-react';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import AppShell from './components/AppShell';
import Splash from './components/Splash';
import { ViewAsBanner } from './components/ViewAs';
import { Button } from './components/ui/Button';
import Callbacks from './pages/Callbacks';
import Leads from './pages/Leads';
import Contacts from './pages/admin/Contacts';
import Numbers from './pages/admin/Numbers';
import Performance from './pages/admin/Performance';
import CallDetailPage from './pages/CallDetailPage';
import CallNumber from './pages/CallNumber';
import Calls from './pages/Calls';
import CampaignPage from './pages/Campaign';
import Campaigns from './pages/Campaigns';
import Dialer from './pages/Dialer';
import Login from './pages/Login';
import { VoiceProvider } from './voice/VoiceProvider';

// Where a signed-out visitor was going (e.g. a click-to-call link from MaronlyOS), to go back to after signing in.
const AFTER_LOGIN_KEY = 'dialer.afterLogin';

function ToLogin() {
  const { pathname, search } = useLocation();
  try {
    if (pathname !== '/login' && pathname !== '/') sessionStorage.setItem(AFTER_LOGIN_KEY, pathname + search);
  } catch {
    // storage blocked: they land on Campaigns instead
  }
  return <Navigate to="/login" replace />;
}

function AfterLogin() {
  const navigate = useNavigate();
  useEffect(() => {
    let to = '/campaigns';
    try {
      to = sessionStorage.getItem(AFTER_LOGIN_KEY) || to;
      sessionStorage.removeItem(AFTER_LOGIN_KEY);
    } catch {
      // ignore
    }
    navigate(to, { replace: true });
  }, [navigate]);
  return null;
}

export default function App() {
  const { status, email, signOut, isAdmin } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<ToLogin />} />
      </Routes>
    );
  }
  if (status === 'forbidden') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-md p-8 text-center">
          <img src="/maronly-mark.png" alt="" className="mx-auto h-14 w-14" />
          <h1 className="mt-4 font-display text-2xl">This app is for the Maronly team</h1>
          <p className="mt-3 text-ink-muted">
            {email} doesn't have dialer access. If you're on the team, ask an admin to set your role to <b>team</b>.
          </p>
          <Button variant="outline" className="mt-6" onClick={signOut}>
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <VoiceProvider>
      <ViewAsBanner />
      <Routes>
        {/* Full screen, no sidebar: the dialer has its own "End dialling session" header. */}
        <Route path="/campaigns/:id/dial" element={<Dialer />} />
        <Route element={<AppShell />}>
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignPage />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/callbacks" element={<Callbacks />} />
          <Route path="/calls/:id" element={<CallDetailPage />} />
          {/* Campaign management moved onto the Campaigns page. */}
          <Route path="/admin/campaigns" element={<Navigate to="/campaigns" replace />} />
          {isAdmin && <Route path="/admin/contacts" element={<Contacts />} />}
          {isAdmin && <Route path="/admin/numbers" element={<Numbers />} />}
          {isAdmin && <Route path="/admin/performance" element={<Performance />} />}
          {isAdmin && <Route path="/call" element={<CallNumber />} />}
        </Route>
        <Route path="/login" element={<AfterLogin />} />
        <Route path="*" element={<Navigate to="/campaigns" replace />} />
      </Routes>
    </VoiceProvider>
  );
}
