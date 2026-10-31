import type { BufferGeometry } from 'three';
import { defaultWeldTolerance, readPositions, triangleCount, triangleVertexIndices } from './attributes';
import { computeConnectivity } from './connectivity';
import { findDegenerateTriangles } from './operations';
import { countMask } from './extract';

export interface GeometryDiagnostics {
  vertexCount: number;
  triangleCount: number;
  indexed: boolean;
  attributes: string[];
  hasNormals: boolean;
  hasUVs: boolean;
  hasVertexColors: boolean;
  hasTangents: boolean;
  morphTargetCount: number;
  groupCount: number;
  componentCount: number;
  weldedVertexCount: number;
  degenerateTriangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** true only when there are no boundary or non-manifold edges (based on welded positions) */
  closed: boolean;
  approximateBytes: number;
  tolerance: number;
}

/** Topological and attribute diagnostics. Edges are evaluated on position-welded vertices. */
export function analyzeGeometry(geometry: BufferGeometry, tolerance?: number): GeometryDiagnostics {
  const positions = readPositions(geometry);
  const tol = tolerance ?? defaultWeldTolerance(positions);
  const triangles = triangleVertexIndices(geometry);
  const conn = computeConnectivity({ positions, triangles }, { tolerance: tol });
  const edgeCounts = new Map<number, number>();
  const n = conn.canonicalCount;
  const t = triangles.length / 3;
  const useBig = n > 94906265; // sqrt(2^53)
  const bigCounts = useBig ? new Map<string, number>() : null;
  for (let i = 0; i < t; i++) {
    for (let k = 0; k < 3; k++) {
      const a = conn.canonicalIds[triangles[i * 3 + k]];
      const b = conn.canonicalIds[triangles[i * 3 + ((k + 1) % 3)]];
      if (a === b) continue;
      const lo = Math.min(a, b),
        hi = Math.max(a, b);
      if (bigCounts) {
        const key = `${lo}:${hi}`;
        bigCounts.set(key, (bigCounts.get(key) ?? 0) + 1);
      } else {
        const key = lo * n + hi;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }
  let boundary = 0,
    nonManifold = 0;
  for (const count of (bigCounts ?? edgeCounts).values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
  }
  let bytes = 0;
  for (const attr of Object.values(geometry.attributes)) bytes += attr.array.byteLength;
  if (geometry.index) bytes += geometry.index.array.byteLength;
  const degenerate = countMask(findDegenerateTriangles(geometry, tol));
  return {
    vertexCount: geometry.getAttribute('position')?.count ?? 0,
    triangleCount: triangleCount(geometry),
    indexed: geometry.index !== null,
    attributes: Object.keys(geometry.attributes),
    hasNormals: !!geometry.getAttribute('normal'),
    hasUVs: !!geometry.getAttribute('uv'),
    hasVertexColors: !!geometry.getAttribute('color'),
    hasTangents: !!geometry.getAttribute('tangent'),
    morphTargetCount: Object.values(geometry.morphAttributes)[0]?.length ?? 0,
    groupCount: geometry.groups.length,
    componentCount: conn.componentCount,
    weldedVertexCount: conn.canonicalCount,
    degenerateTriangles: degenerate,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    closed: boundary === 0 && nonManifold === 0 && t > 0,
    approximateBytes: bytes,
    tolerance: tol,
  };
}
