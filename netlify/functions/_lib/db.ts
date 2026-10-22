import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './http';

let client: SupabaseClient | null = null;

/** Supabase with the service role key: bypasses RLS, so only use it after checking who's asking. Server only. */
export function db(): SupabaseClient {
  client ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Throws the Supabase error (logged by `handler`) instead of returning it. */
export function must<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Supabase: ${result.error.message}`);
  return result.data;
}
