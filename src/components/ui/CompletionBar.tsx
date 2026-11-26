/**
 * The progress bar: dialled in the brand colour (green once nothing is left), skipped in yellow after it. A campaign
 * with only skipped contacts left to finish is full: skipped contacts count towards completion.
 */
export function CompletionBar({ total, dialled, skipped, complete, className = '' }: { total: number; dialled: number; skipped: number; complete: boolean; className?: string }) {
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <span
      className={`flex overflow-hidden rounded-full bg-neutral-100 ${className}`}
      role="img"
      aria-label={`${dialled.toLocaleString()} dialled${skipped ? `, ${skipped.toLocaleString()} skipped` : ''}, of ${total.toLocaleString()}`}
    >
      <span className={`block h-full transition-[width] ${complete ? 'bg-emerald-500' : 'bg-brand'}`} style={{ width: `${pct(dialled)}%` }} />
      {skipped > 0 && <span className="block h-full bg-amber-300 transition-[width]" style={{ width: `${pct(skipped)}%` }} />}
    </span>
  );
}
