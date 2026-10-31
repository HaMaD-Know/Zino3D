import { Capacitor } from '@capacitor/core';
import { sanitizeFileName } from '../utils/format';

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Opens the platform file picker (browser input, iOS Files, Android document picker — Capacitor
 * WebViews route <input type=file> to the native pickers).
 */
export function pickFiles(options: { accept: string; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Android's picker cannot map custom extensions such as .glb to MIME types; allow everything there.
    input.accept = Capacitor.getPlatform() === 'android' ? '*/*' : options.accept;
    input.multiple = options.multiple ?? false;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk)
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  return btoa(binary);
}

export type SaveOutcome = 'shared' | 'saved' | 'downloaded' | 'cancelled';

/**
 * Saves/shares a generated file.
 * - Native (Capacitor): written to the app cache, then the system share sheet opens (Save to Files,
 *   AirDrop, Drive, …). Browser downloads do not work inside native WebViews.
 * - Browsers with the File System Access API: native "Save as" dialog.
 * - Otherwise: a regular download.
 */
export async function saveFile(blob: Blob, fileName: string): Promise<SaveOutcome> {
  const name = sanitizeFileName(fileName);
  if (isNative()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ]);
    // The bridge transfers base64; this is a transport detail, nothing is persisted as base64.
    const written = await Filesystem.writeFile({
      path: name,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({ title: name, files: [written.uri], dialogTitle: `Save ${name}` });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && /cancel/i.test(error.message)) return 'cancelled';
      throw error;
    }
  }
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker;
  if (picker && window.isSecureContext && window.self === window.top) {
    try {
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      const handle = await picker({
        suggestedName: name,
        types: ext
          ? [
              {
                description: `${ext.slice(1).toUpperCase()} file`,
                accept: { [blob.type || 'application/octet-stream']: [ext] },
              },
            ]
          : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      // Fall back to a download (e.g. unsupported MIME type in the picker).
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
