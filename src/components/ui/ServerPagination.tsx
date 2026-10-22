import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Pager for lists paged in the database (`page` is 0-based). */
export function ServerPagination({ page, perPage, total, setPage, noun }: { page: number; perPage: number; total: number; setPage: (p: number) => void; noun: string }) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (pageCount <= 1) return null;
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full border border-line-strong transition hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="mt-5 flex flex-col items-center justify-between gap-3 border-t border-line pt-5 text-sm text-ink-muted sm:flex-row">
      <span className="tabular-nums">
        {(page * perPage + 1).toLocaleString()}–{Math.min(total, (page + 1) * perPage).toLocaleString()} of {total.toLocaleString()} {noun}
      </span>
      <div className="flex items-center gap-2">
        <button className={btn} onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Previous page">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-[90px] text-center tabular-nums">
          Page {page + 1} of {pageCount}
        </span>
        <button className={btn} onClick={() => setPage(page + 1)} disabled={page + 1 >= pageCount} aria-label="Next page">
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
