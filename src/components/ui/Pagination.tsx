import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { usePagination } from './usePagination';

export function Pagination({ page, pageCount, setPage, total, perPage, noun }: ReturnType<typeof usePagination> & { noun: string }) {
  if (pageCount <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full border border-line-strong transition hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="mt-5 flex flex-col items-center justify-between gap-3 border-t border-line pt-5 text-sm text-ink-muted sm:flex-row">
      <span className="tabular-nums">
        {from}–{to} of {total} {noun}
      </span>
      <div className="flex items-center gap-2">
        <button className={btn} onClick={() => setPage(page - 1)} disabled={page === 1} aria-label="Previous page">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-[90px] text-center tabular-nums">
          Page {page} of {pageCount}
        </span>
        <button className={btn} onClick={() => setPage(page + 1)} disabled={page === pageCount} aria-label="Next page">
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
