/** A small pulsing red dot. */
export function RedOrb({ title }: { title: string }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0" title={title} role="img" aria-label={title}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
    </span>
  );
}
