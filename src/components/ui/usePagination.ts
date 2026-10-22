import { useEffect, useMemo, useState } from 'react';

export function usePagination<T>(items: T[], perPage: number, resetKey: unknown) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  useEffect(() => setPage(1), [resetKey]);
  const current = Math.min(page, pageCount);
  const pageItems = useMemo(() => items.slice((current - 1) * perPage, current * perPage), [items, current, perPage]);
  return { page: current, pageCount, pageItems, setPage, total: items.length, perPage };
}
