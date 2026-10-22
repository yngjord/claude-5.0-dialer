export function Metric({ label, value, note, muted, loading }: { label: string; value: string | number; note?: string; muted?: boolean; loading?: boolean }) {
  return (
    <div className={`card p-5 sm:p-6 ${muted ? 'border-dashed bg-neutral-50 shadow-none' : ''}`} aria-busy={loading}>
      <p className="font-display text-[13px] font-medium text-ink-muted">{label}</p>
      <p className={`mt-2 font-display text-[28px] font-medium tracking-tight sm:text-[34px] ${muted ? 'text-ink-faint' : ''}`}>
        {/* Skeleton sits inside the same line box so the card doesn't change height when data arrives */}
        {loading ? <span className="skeleton inline-block h-[0.85em] w-28 align-middle" aria-label="Loading" /> : value}
      </p>
      {note && <p className="mt-1 text-xs text-ink-faint">{note}</p>}
    </div>
  );
}
