import { useEffect, useState } from 'react';
import { api } from './api';
import { supabase } from './supabase';

const STORAGE_KEY = 'dialer.clientLogos';

function readSaved(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

// Shared by every page that shows logos: one database read per page load.
let loading: Promise<Record<string, string>> | null = null;

async function load(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('dialer_client_logos').select('airtable_client_id, url');
  if (error) throw error;
  let logos = Object.fromEntries((data as { airtable_client_id: string; url: string }[]).map((r) => [r.airtable_client_id, r.url]));
  // None copied yet (e.g. straight after setup): copy them from Airtable now.
  if (!Object.keys(logos).length) logos = await api<Record<string, string>>('client-logos', { method: 'POST' });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logos));
  } catch {
    // per-browser convenience only
  }
  return logos;
}

/**
 * Client logos by Airtable client id: our stored copies of Clients → Client Logo Image. Shows the last-known logos
 * straight away (this browser remembers them), then refreshes from the database.
 */
export function useClientLogos(): Record<string, string> {
  const [logos, setLogos] = useState<Record<string, string>>(readSaved);
  useEffect(() => {
    let cancelled = false;
    loading ??= load().catch(() => {
      loading = null;
      return readSaved();
    });
    loading.then((l) => !cancelled && setLogos(l));
    return () => {
      cancelled = true;
    };
  }, []);
  return logos;
}
