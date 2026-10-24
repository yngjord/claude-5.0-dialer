import { useState } from 'react';

/** The client's logo (from Airtable), or their name when there's no logo or it doesn't load. */
export function ClientLogo({ name, url }: { name: string; url: string | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <span className="text-ink-muted">{name}</span>;
  return <img src={url} alt={name} title={name} onError={() => setBroken(true)} className="h-10 w-10 shrink-0 rounded-full border border-line object-cover" />;
}
