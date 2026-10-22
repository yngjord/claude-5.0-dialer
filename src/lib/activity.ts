import { useSyncExternalStore } from 'react';

// Counts in-flight /api requests so the shell can show a global loading bar.
let pending = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function track<T>(promise: Promise<T>): Promise<T> {
  pending++;
  emit();
  try {
    return await promise;
  } finally {
    pending--;
    emit();
  }
}

export function useIsLoading(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending > 0,
  );
}
