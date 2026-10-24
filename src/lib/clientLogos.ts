import { useEffect, useState } from 'react';
import { api } from './api';

// Shared by every campaign list. Airtable's file links expire after a couple of hours, so refetch after one.
let cached: Promise<Record<string, string>> | null = null;
let fetchedAt = 0;

/** Client logos from Airtable (Clients → Client Logo Image), by Airtable client id. Empty until loaded or if it fails. */
export function useClientLogos(): Record<string, string> {
  const [logos, setLogos] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    if (Date.now() - fetchedAt > 60 * 60_000) {
      cached = null;
      fetchedAt = Date.now();
    }
    cached ??= api<Record<string, string>>('client-logos').catch(() => {
      cached = null;
      return {};
    });
    cached.then((l) => !cancelled && setLogos(l));
    return () => {
      cancelled = true;
    };
  }, []);
  return logos;
}
