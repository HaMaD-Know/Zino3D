import { useSyncExternalStore } from 'react';
import { DEFAULT_VIEWPORT_OPTIONS, type ViewportOptions } from '../engine/viewport/Viewport';

export interface Preferences {
  viewport: ViewportOptions;
  autosaveSeconds: number;
  exportMaxTextureSize: number;
  confirmDeletes: boolean;
}

const KEY = 'zino3d.preferences';

function lowPowerDefaults(): Partial<ViewportOptions> {
  if (typeof navigator === 'undefined') return {};
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  return coarse || (mem !== undefined && mem <= 4) ? { maxPixelRatio: 1.5 } : {};
}

const defaults: Preferences = {
  viewport: { ...DEFAULT_VIEWPORT_OPTIONS, ...lowPowerDefaults() },
  autosaveSeconds: 2,
  exportMaxTextureSize: 4096,
  confirmDeletes: true,
};

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...defaults, ...parsed, viewport: { ...defaults.viewport, ...(parsed.viewport ?? {}) } };
  } catch {
    return defaults;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getPreferences(): Preferences {
  return current;
}

export function updatePreferences(patch: Partial<Preferences>): void {
  current = { ...current, ...patch, viewport: { ...current.viewport, ...(patch.viewport ?? {}) } };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Preferences remain in memory for this session.
  }
  listeners.forEach((l) => l());
}

export function resetPreferences(): void {
  updatePreferences(defaults);
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
