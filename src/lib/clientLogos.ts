import { useEffect, useState } from 'react';
import { api } from './api';

// One fetch per page load: logos rarely change, and every campaign list shares them.
let cached: Promise<Record<string, string>> | null = null;

/** Client logos from Airtable (Clients → Logo URL), by Airtable client id. Empty until loaded or if it fails. */
export function useClientLogos(): Record<string, string> {
  const [logos, setLogos] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
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
