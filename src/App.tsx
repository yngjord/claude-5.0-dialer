import { LogOut } from 'lucide-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import AppShell from './components/AppShell';
import Splash from './components/Splash';
import { Button } from './components/ui/Button';
import AdminCampaigns from './pages/admin/AdminCampaigns';
import Numbers from './pages/admin/Numbers';
import CallDetailPage from './pages/CallDetailPage';
import Calls from './pages/Calls';
import CampaignPage from './pages/Campaign';
import Campaigns from './pages/Campaigns';
import Dialer from './pages/Dialer';
import Login from './pages/Login';
import { VoiceProvider } from './voice/VoiceProvider';

export default function App() {
  const { status, email, signOut, isAdmin } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
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
      <Routes>
        {/* Full screen, no sidebar: the dialer has its own "End dialling session" header. */}
        <Route path="/campaigns/:id/dial" element={<Dialer />} />
        <Route element={<AppShell />}>
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignPage />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetailPage />} />
          {isAdmin && <Route path="/admin/campaigns" element={<AdminCampaigns />} />}
          {isAdmin && <Route path="/admin/numbers" element={<Numbers />} />}
        </Route>
        <Route path="*" element={<Navigate to="/campaigns" replace />} />
      </Routes>
    </VoiceProvider>
  );
}
