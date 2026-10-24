import { useState } from 'react';

/** The client's logo (from Airtable), or their name when there's no logo or it doesn't load. */
export function ClientLogo({ name, url }: { name: string; url: string | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <span className="text-ink-muted">{name}</span>;
  return <img src={url} alt={name} title={name} onError={() => setBroken(true)} className="h-9 max-w-[120px] rounded-lg object-contain object-left" />;
}
