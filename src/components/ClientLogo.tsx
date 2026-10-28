import { useState } from 'react';

/**
 * The client's logo (from Airtable) in a circle, or their name when there's no logo or it doesn't load. The fixed
 * min/max width stops a narrow table cell squeezing it into an oval (img defaults to max-width: 100%).
 */
export function ClientLogo({ name, url }: { name: string; url: string | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <span className="text-ink-muted">{name}</span>;
  return <img src={url} alt={name} title={name} onError={() => setBroken(true)} className="aspect-square h-10 w-10 min-w-10 max-w-none shrink-0 rounded-full border border-line object-cover" />;
}
