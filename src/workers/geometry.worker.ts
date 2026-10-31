/// <reference lib="webworker" />
import { computeConnectivity } from '../engine/geometry/connectivity';

export interface ConnectivityRequest {
  id: number;
  positions: Float32Array;
  triangles: Uint32Array;
  tolerance: number;
}

self.onmessage = (event: MessageEvent<ConnectivityRequest>) => {
  const { id, positions, triangles, tolerance } = event.data;
  try {
    const result = computeConnectivity({ positions, triangles }, { tolerance });
    (self as unknown as Worker).postMessage({ id, ok: true, result }, [
      result.triangleComponent.buffer,
      result.canonicalIds.buffer,
    ]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
