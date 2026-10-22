import { useCallback, useEffect, useState } from 'react';
import { track } from './activity';
import { supabase } from './supabase';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Calls a Netlify Function with the current Supabase session token. */
export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return track(request<T>(path, init));
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) await supabase.auth.signOut();
    throw new ApiError(res.status, body.error ?? 'Something went wrong. Please try again.');
  }
  return body as T;
}

/** Throws a Supabase query error instead of returning it. */
export function must<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/**
 * Runs an async loader (Supabase query or API call) and tracks loading/error state.
 * Re-runs when `deps` change; `reload` re-runs on demand.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const reload = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setLoading(true);
      setError(null);
      try {
        setData(await track(run()));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setLoading(false);
      }
    },
    [run],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}
