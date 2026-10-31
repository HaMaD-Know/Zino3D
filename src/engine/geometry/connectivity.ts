import { canonicalizeVertices } from './spatialHash';

export interface ComponentSummary {
  /** Stable id: components are numbered in order of their first triangle. */
  id: number;
  triangleCount: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface ConnectivityResult {
  componentCount: number;
  /** component id for every triangle */
  triangleComponent: Uint32Array;
  components: ComponentSummary[];
  /** canonical (welded) vertex id per original vertex */
  canonicalIds: Uint32Array;
  canonicalCount: number;
}

export interface ConnectivityInput {
  positions: Float32Array;
  /** vertex indices, 3 per triangle */
  triangles: Uint32Array;
}

export interface ConnectivityOptions {
  /**
   * When true (default) vertices whose positions are within `tolerance` are treated as connected,
   * which reconstructs topology of meshes split at UV/normal seams and of non-indexed meshes.
   * When false only shared vertex indices connect triangles.
   */
  weld?: boolean;
  tolerance: number;
}

function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

function union(parent: Int32Array, rank: Uint8Array, a: number, b: number): void {
  let ra = find(parent, a);
  let rb = find(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
  parent[rb] = ra;
  if (rank[ra] === rank[rb]) rank[ra]++;
}

/** Finds connected components (loose parts) of a triangle mesh. Pure function, safe for workers. */
export function computeConnectivity(
  input: ConnectivityInput,
  options: ConnectivityOptions,
): ConnectivityResult {
  const { positions, triangles } = input;
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = Math.floor(triangles.length / 3);
  let canonicalIds: Uint32Array;
  let canonicalCount: number;
  if (options.weld === false) {
    canonicalIds = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) canonicalIds[i] = i;
    canonicalCount = vertexCount;
  } else {
    const canon = canonicalizeVertices(positions, options.tolerance);
    canonicalIds = canon.ids;
    canonicalCount = canon.count;
  }

  const parent = new Int32Array(canonicalCount);
  for (let i = 0; i < canonicalCount; i++) parent[i] = i;
  const rank = new Uint8Array(canonicalCount);
  for (let t = 0; t < triCount; t++) {
    const a = canonicalIds[triangles[t * 3]];
    const b = canonicalIds[triangles[t * 3 + 1]];
    const c = canonicalIds[triangles[t * 3 + 2]];
    union(parent, rank, a, b);
    union(parent, rank, a, c);
  }

  const rootToComponent = new Map<number, number>();
  const triangleComponent = new Uint32Array(triCount);
  const components: ComponentSummary[] = [];
  for (let t = 0; t < triCount; t++) {
    const root = find(parent, canonicalIds[triangles[t * 3]]);
    let id = rootToComponent.get(root);
    if (id === undefined) {
      id = components.length;
      rootToComponent.set(root, id);
      components.push({
        id,
        triangleCount: 0,
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      });
    }
    triangleComponent[t] = id;
    const comp = components[id];
    comp.triangleCount++;
    for (let k = 0; k < 3; k++) {
      const v = triangles[t * 3 + k];
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[v * 3 + axis];
        if (value < comp.min[axis]) comp.min[axis] = value;
        if (value > comp.max[axis]) comp.max[axis] = value;
      }
    }
  }
  return { componentCount: components.length, triangleComponent, components, canonicalIds, canonicalCount };
}
