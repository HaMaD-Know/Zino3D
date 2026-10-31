import { computeConnectivity, type ConnectivityResult } from './connectivity';

/** Meshes above this triangle count are processed in a Web Worker to keep the UI responsive. */
export const WORKER_TRIANGLE_THRESHOLD = 150_000;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: ConnectivityResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('../../workers/geometry.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (
        event: MessageEvent<{ id: number; ok: boolean; result?: ConnectivityResult; error?: string }>,
      ) => {
        const p = pending.get(event.data.id);
        if (!p) return;
        pending.delete(event.data.id);
        if (event.data.ok && event.data.result) p.resolve(event.data.result);
        else p.reject(new Error(event.data.error ?? 'Geometry worker failed.'));
      };
      worker.onerror = (event) => {
        for (const p of pending.values()) p.reject(new Error(event.message || 'Geometry worker crashed.'));
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    } catch {
      worker = null;
    }
  }
  return worker;
}

/** Connected-component analysis, off the main thread for large meshes. Inputs are copied, not transferred. */
export async function computeConnectivityAsync(
  positions: Float32Array,
  triangles: Uint32Array,
  tolerance: number,
): Promise<ConnectivityResult> {
  const w = triangles.length / 3 >= WORKER_TRIANGLE_THRESHOLD ? getWorker() : null;
  if (!w) return computeConnectivity({ positions, triangles }, { tolerance });
  const id = nextId++;
  return new Promise<ConnectivityResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, positions: positions.slice(), triangles: triangles.slice(), tolerance });
  });
}
