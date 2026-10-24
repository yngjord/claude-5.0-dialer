import { useState } from 'react';

/** A team member's profile picture, or their initials when they don't have one (or it doesn't load). */
export function Avatar({ url, name, size = 'h-8 w-8' }: { url: string | undefined; name: string; size?: string }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return url && !broken ? (
    <img src={url} alt={name} title={name} onError={() => setBroken(true)} className={`${size} shrink-0 rounded-full object-cover ring-2 ring-white`} />
  ) : (
    <span title={name} className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand ring-2 ring-white`}>
      {initials}
    </span>
  );
}
