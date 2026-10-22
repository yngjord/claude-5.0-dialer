import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { supabase } from '../lib/supabase';

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  /** Signed in with a portal account that isn't team/admin. */
  | { status: 'forbidden'; email: string }
  | { status: 'signed-in'; me: Me | null; error: string | null };

interface AuthContextValue {
  status: AuthState['status'];
  me: Me | null;
  error: string | null;
  email: string | null;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const loadMe = useCallback(async (session: Session | null) => {
    if (!session) return setState({ status: 'signed-out' });
    try {
      setState({ status: 'signed-in', me: await api<Me>('me'), error: null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return setState({ status: 'forbidden', email: session.user.email ?? '' });
      setState({ status: 'signed-in', me: null, error: err instanceof Error ? err.message : 'Could not load your account.' });
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => loadMe(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Token refreshes keep the same user; only react to sign-in/out.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        // Defer: Supabase recommends not awaiting other auth calls inside this callback.
        setTimeout(() => loadMe(session), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [loadMe]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const me = state.status === 'signed-in' ? state.me : null;
  const value: AuthContextValue = {
    status: state.status,
    me,
    error: state.status === 'signed-in' ? state.error : null,
    email: state.status === 'forbidden' ? state.email : (me?.email ?? null),
    isAdmin: me?.role === 'admin',
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
