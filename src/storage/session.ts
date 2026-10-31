/**
 * Unclean-shutdown detection. While a project is open we keep a small marker in localStorage; it is
 * cleared on a clean close. If the marker is present at startup the app offers recovery.
 */
const KEY = 'zino3d.session';

export interface SessionMarker {
  projectId: string;
  projectName: string;
  openedAt: number;
  lastSavedAt: number | null;
  unsavedChanges: boolean;
}

export function readSessionMarker(): SessionMarker | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SessionMarker) : null;
  } catch {
    return null;
  }
}

export function writeSessionMarker(marker: SessionMarker): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marker));
  } catch {
    // Storage may be unavailable (private mode); recovery prompts are then not shown.
  }
}

export function clearSessionMarker(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore: nothing to clear when storage is unavailable
  }
}
