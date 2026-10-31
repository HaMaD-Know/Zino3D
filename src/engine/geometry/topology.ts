import type { BufferGeometry } from 'three';
import {
  defaultWeldTolerance,
  readPositions,
  triangleMaterialIndices,
  triangleVertexIndices,
} from './attributes';
import { computeConnectivity, type ConnectivityResult } from './connectivity';
import { computeConnectivityAsync } from './workerClient';

/**
 * Cached topology used by Edit Mode. Vertices are identified by canonical (position-welded) ids so
 * that selecting a vertex selects every split copy of it (UV seams), as users expect.
 */
export interface MeshTopology {
  geometry: BufferGeometry;
  tolerance: number;
  positions: Float32Array;
  triangles: Uint32Array;
  triangleMaterials: Int32Array;
  connectivity: ConnectivityResult;
  /** canonical vertex position (xyz) */
  canonicalPositions: Float32Array;
  /** triangles adjacent to each canonical vertex (CSR layout) */
  vertexTriangleOffsets: Uint32Array;
  vertexTriangles: Uint32Array;
  triangleCount: number;
}

const cache = new WeakMap<BufferGeometry, MeshTopology>();

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split('_');
  return [Number(a), Number(b)];
}

export function hasTopology(geometry: BufferGeometry): boolean {
  return cache.has(geometry);
}

/** Computes (in a worker for large meshes) and caches topology so later getTopology calls are instant. */
export async function prepareTopology(geometry: BufferGeometry): Promise<MeshTopology> {
  const cached = cache.get(geometry);
  if (cached) return cached;
  const positions = readPositions(geometry);
  const tolerance = defaultWeldTolerance(positions);
  const triangles = triangleVertexIndices(geometry);
  const connectivity = await computeConnectivityAsync(positions, triangles, tolerance);
  return buildTopology(geometry, positions, tolerance, triangles, connectivity);
}

export function getTopology(geometry: BufferGeometry): MeshTopology {
  const cached = cache.get(geometry);
  if (cached) return cached;
  const positions = readPositions(geometry);
  const tolerance = defaultWeldTolerance(positions);
  const triangles = triangleVertexIndices(geometry);
  const connectivity = computeConnectivity({ positions, triangles }, { tolerance });
  return buildTopology(geometry, positions, tolerance, triangles, connectivity);
}

function buildTopology(
  geometry: BufferGeometry,
  positions: Float32Array,
  tolerance: number,
  triangles: Uint32Array,
  connectivity: ConnectivityResult,
): MeshTopology {
  const triCount = triangles.length / 3;
  const canonicalPositions = new Float32Array(connectivity.canonicalCount * 3);
  for (let v = 0; v < positions.length / 3; v++) {
    const c = connectivity.canonicalIds[v];
    canonicalPositions[c * 3] = positions[v * 3];
    canonicalPositions[c * 3 + 1] = positions[v * 3 + 1];
    canonicalPositions[c * 3 + 2] = positions[v * 3 + 2];
  }
  const counts = new Uint32Array(connectivity.canonicalCount + 1);
  for (let i = 0; i < triangles.length; i++) counts[connectivity.canonicalIds[triangles[i]] + 1]++;
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const offsets = counts.slice();
  const fill = counts.slice(0, -1);
  const vertexTriangles = new Uint32Array(triangles.length);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const c = connectivity.canonicalIds[triangles[t * 3 + k]];
      vertexTriangles[fill[c]++] = t;
    }
  }
  const topo: MeshTopology = {
    geometry,
    tolerance,
    positions,
    triangles,
    triangleMaterials: triangleMaterialIndices(geometry),
    connectivity,
    canonicalPositions,
    vertexTriangleOffsets: offsets,
    vertexTriangles,
    triangleCount: triCount,
  };
  cache.set(geometry, topo);
  return topo;
}

export function triangleCanonical(topo: MeshTopology, t: number): [number, number, number] {
  const ids = topo.connectivity.canonicalIds;
  return [ids[topo.triangles[t * 3]], ids[topo.triangles[t * 3 + 1]], ids[topo.triangles[t * 3 + 2]]];
}

export type ElementMode = 'vertex' | 'edge' | 'face';

export interface ElementSelection {
  vertices: Set<number>;
  edges: Set<string>;
  faces: Set<number>;
}

export function emptyElementSelection(): ElementSelection {
  return { vertices: new Set(), edges: new Set(), faces: new Set() };
}

/**
 * Converts an element selection to a triangle mask.
 * - 'contained': triangles whose every vertex/edge is selected (used by separate/duplicate).
 * - 'touching': triangles that use any selected vertex/edge (used by delete vertices/edges).
 */
export function selectionToTriangleMask(
  topo: MeshTopology,
  mode: ElementMode,
  sel: ElementSelection,
  rule: 'contained' | 'touching',
): Uint8Array {
  const mask = new Uint8Array(topo.triangleCount);
  if (mode === 'face') {
    for (const f of sel.faces) if (f < mask.length) mask[f] = 1;
    return mask;
  }
  for (let t = 0; t < topo.triangleCount; t++) {
    const [a, b, c] = triangleCanonical(topo, t);
    if (mode === 'vertex') {
      const hits =
        (sel.vertices.has(a) ? 1 : 0) + (sel.vertices.has(b) ? 1 : 0) + (sel.vertices.has(c) ? 1 : 0);
      mask[t] = rule === 'contained' ? (hits === 3 ? 1 : 0) : hits > 0 ? 1 : 0;
    } else {
      const e = [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)];
      const hits = e.filter((k) => sel.edges.has(k)).length;
      mask[t] = rule === 'contained' ? (hits === 3 ? 1 : 0) : hits > 0 ? 1 : 0;
    }
  }
  return mask;
}

/** Expands the selection to every connected component it touches. */
export function selectLinked(topo: MeshTopology, mode: ElementMode, sel: ElementSelection): ElementSelection {
  const touched = selectionToTriangleMask(topo, mode, sel, 'touching');
  const comps = new Set<number>();
  for (let t = 0; t < touched.length; t++) if (touched[t]) comps.add(topo.connectivity.triangleComponent[t]);
  const tris: number[] = [];
  for (let t = 0; t < topo.triangleCount; t++)
    if (comps.has(topo.connectivity.triangleComponent[t])) tris.push(t);
  return selectionFromTriangles(topo, mode, tris);
}

/** Builds a selection in the given mode containing exactly the elements of the given triangles. */
export function selectionFromTriangles(
  topo: MeshTopology,
  mode: ElementMode,
  tris: Iterable<number>,
): ElementSelection {
  const sel = emptyElementSelection();
  for (const t of tris) {
    if (mode === 'face') {
      sel.faces.add(t);
      continue;
    }
    const [a, b, c] = triangleCanonical(topo, t);
    if (mode === 'vertex') {
      sel.vertices.add(a);
      sel.vertices.add(b);
      sel.vertices.add(c);
    } else {
      sel.edges.add(edgeKey(a, b));
      sel.edges.add(edgeKey(b, c));
      sel.edges.add(edgeKey(c, a));
    }
  }
  return sel;
}

export function selectAllElements(topo: MeshTopology, mode: ElementMode): ElementSelection {
  return selectionFromTriangles(
    topo,
    mode,
    Array.from({ length: topo.triangleCount }, (_, i) => i),
  );
}

export function invertElementSelection(
  topo: MeshTopology,
  mode: ElementMode,
  sel: ElementSelection,
): ElementSelection {
  const all = selectAllElements(topo, mode);
  const out = emptyElementSelection();
  if (mode === 'face') for (const f of all.faces) if (!sel.faces.has(f)) out.faces.add(f);
  if (mode === 'vertex') for (const v of all.vertices) if (!sel.vertices.has(v)) out.vertices.add(v);
  if (mode === 'edge') for (const e of all.edges) if (!sel.edges.has(e)) out.edges.add(e);
  return out;
}

export function selectByMaterial(
  topo: MeshTopology,
  mode: ElementMode,
  materialIndex: number,
): ElementSelection {
  const tris: number[] = [];
  for (let t = 0; t < topo.triangleCount; t++) if (topo.triangleMaterials[t] === materialIndex) tris.push(t);
  return selectionFromTriangles(topo, mode, tris);
}

/** Converts a selection between element modes (keeping the same geometric region). */
export function convertSelection(
  topo: MeshTopology,
  from: ElementMode,
  to: ElementMode,
  sel: ElementSelection,
): ElementSelection {
  if (from === to) return sel;
  const mask = selectionToTriangleMask(topo, from, sel, from === 'face' ? 'contained' : 'contained');
  const tris: number[] = [];
  for (let t = 0; t < mask.length; t++) if (mask[t]) tris.push(t);
  const out = selectionFromTriangles(topo, to, tris);
  // Keep lone vertices/edges when converting from vertex to edge, etc.
  if (from === 'vertex' && to === 'edge') {
    for (let t = 0; t < topo.triangleCount; t++) {
      const [a, b, c] = triangleCanonical(topo, t);
      for (const [x, y] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const)
        if (sel.vertices.has(x) && sel.vertices.has(y)) out.edges.add(edgeKey(x, y));
    }
  }
  if (from === 'edge' && to === 'vertex') {
    for (const key of sel.edges) {
      const [a, b] = parseEdgeKey(key);
      out.vertices.add(a);
      out.vertices.add(b);
    }
  }
  return out;
}

export function selectionSize(mode: ElementMode, sel: ElementSelection): number {
  return mode === 'face' ? sel.faces.size : mode === 'vertex' ? sel.vertices.size : sel.edges.size;
}
