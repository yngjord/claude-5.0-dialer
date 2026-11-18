import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');

export const supabase = createClient(url, anonKey);

/**
 * Calls a database function in a request that outlives the page (closing the tab or reloading), for small cleanups
 * such as giving back a held contact. Best effort.
 */
export async function rpcOnUnload(fn: string, args: Record<string, unknown>, accessToken: string | null): Promise<void> {
  if (!accessToken) return;
  await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    keepalive: true,
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).catch(() => undefined);
}
