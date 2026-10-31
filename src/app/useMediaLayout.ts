import { useSyncExternalStore } from 'react';

export type LayoutMode = 'desktop' | 'tablet' | 'phone';

function compute(): LayoutMode {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < 700) return 'phone';
  if (w < 1100) return 'tablet';
  return 'desktop';
}

let mode = compute();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const next = compute();
    if (next !== mode) {
      mode = next;
      listeners.forEach((l) => l());
    }
  });
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mode,
  );
}
