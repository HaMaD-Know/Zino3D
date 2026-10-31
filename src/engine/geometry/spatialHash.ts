/**
 * Tolerance-based vertex canonicalisation using a uniform spatial hash.
 *
 * Every vertex is assigned the id of the first previously seen canonical vertex within `tolerance`
 * (Euclidean distance). This is a greedy, order-dependent clustering: chains of points that are each
 * within tolerance of the next are not transitively merged. That is the documented behaviour and is
 * adequate for reconstructing topology of meshes that were split at UV / normal seams.
 */
export interface CanonicalVertices {
  /** canonical id for every input vertex */
  ids: Uint32Array;
  /** number of distinct canonical vertices */
  count: number;
  /** xyz of each canonical vertex (length count*3) */
  positions: Float32Array;
}

const P1 = 73856093;
const P2 = 19349663;
const P3 = 83492791;

export function canonicalizeVertices(positions: Float32Array, tolerance: number): CanonicalVertices {
  const vertexCount = Math.floor(positions.length / 3);
  const tol = Math.max(tolerance, 1e-12);
  const tol2 = tol * tol;
  const cell = tol * 4;
  const inv = 1 / cell;
  const ids = new Uint32Array(vertexCount);
  const canon = new Float32Array(vertexCount * 3);
  const buckets = new Map<number, number[]>();
  let count = 0;

  const key = (ix: number, iy: number, iz: number): number =>
    (Math.imul(ix | 0, P1) ^ Math.imul(iy | 0, P2) ^ Math.imul(iz | 0, P3)) | 0;

  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const fx = x * inv,
      fy = y * inv,
      fz = z * inv;
    const ix = Math.floor(fx),
      iy = Math.floor(fy),
      iz = Math.floor(fz);
    // Only probe neighbouring cells along an axis when the point is close to that cell boundary.
    const rx = (fx - ix) * cell,
      ry = (fy - iy) * cell,
      rz = (fz - iz) * cell;
    const x0 = rx < tol ? -1 : 0,
      x1 = rx > cell - tol ? 1 : 0;
    const y0 = ry < tol ? -1 : 0,
      y1 = ry > cell - tol ? 1 : 0;
    const z0 = rz < tol ? -1 : 0,
      z1 = rz > cell - tol ? 1 : 0;

    let found = -1;
    search: for (let dx = x0; dx <= x1; dx++) {
      for (let dy = y0; dy <= y1; dy++) {
        for (let dz = z0; dz <= z1; dz++) {
          const bucket = buckets.get(key(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const c = bucket[b];
            const ddx = canon[c * 3] - x,
              ddy = canon[c * 3 + 1] - y,
              ddz = canon[c * 3 + 2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) {
              found = c;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = count++;
      canon[found * 3] = x;
      canon[found * 3 + 1] = y;
      canon[found * 3 + 2] = z;
      const k = key(ix, iy, iz);
      const bucket = buckets.get(k);
      if (bucket) bucket.push(found);
      else buckets.set(k, [found]);
    }
    ids[v] = found;
  }
  return { ids, count, positions: canon.slice(0, count * 3) };
}
