import { useEffect, useState } from 'react';

/**
 * useState that survives leaving the page and coming back in this browser tab (sessionStorage), e.g. a page's filters
 * when you open a campaign and go back. Falls back to plain state if storage is blocked.
 */
export function useSessionState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved !== null) return JSON.parse(saved) as T;
    } catch {
      // Blocked or unreadable: start fresh.
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the filter just won't be remembered.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
