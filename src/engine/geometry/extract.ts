import { BufferAttribute, BufferGeometry } from 'three';
import {
  type AnyAttribute,
  gatherAttribute,
  triangleCount,
  triangleMaterialIndices,
  triangleVertexIndices,
} from './attributes';

export interface ExtractOptions {
  /** Reverse triangle winding (used by flip normals). */
  flipWinding?: boolean;
}

/**
 * Builds a new indexed geometry containing only the triangles whose mask entry is non-zero.
 *
 * Preserved: every vertex attribute (raw values, storage type, normalization), morph targets,
 * per-triangle material assignment (rebuilt as contiguous groups), geometry name and userData.
 * Unused vertices are dropped. Triangle order is stable within each material.
 */
export function extractTriangles(
  geometry: BufferGeometry,
  mask: Uint8Array,
  options: ExtractOptions = {},
): BufferGeometry {
  const triCount = triangleCount(geometry);
  if (mask.length !== triCount)
    throw new Error(`Triangle mask length ${mask.length} does not match ${triCount}`);
  const triVerts = triangleVertexIndices(geometry);
  const triMats = triangleMaterialIndices(geometry);
  const hasGroups = geometry.groups.length > 0;

  const selected: number[] = [];
  for (let t = 0; t < triCount; t++) if (mask[t]) selected.push(t);
  if (hasGroups) {
    // Stable sort by material index; ungrouped (-1) triangles go last.
    selected.sort((a, b) => {
      const ma = triMats[a] < 0 ? Number.MAX_SAFE_INTEGER : triMats[a];
      const mb = triMats[b] < 0 ? Number.MAX_SAFE_INTEGER : triMats[b];
      return ma - mb || a - b;
    });
  }

  const vertexCount = geometry.getAttribute('position')?.count ?? 0;
  const remap = new Int32Array(vertexCount).fill(-1);
  const newToOld: number[] = [];
  const index = new Uint32Array(selected.length * 3);
  for (let i = 0; i < selected.length; i++) {
    const t = selected[i];
    for (let k = 0; k < 3; k++) {
      const kk = options.flipWinding && k > 0 ? 3 - k : k; // 0,2,1 when flipping
      const old = triVerts[t * 3 + kk];
      let nv = remap[old];
      if (nv < 0) {
        nv = newToOld.length;
        remap[old] = nv;
        newToOld.push(old);
      }
      index[i * 3 + k] = nv;
    }
  }

  const out = new BufferGeometry();
  out.name = geometry.name;
  out.userData = structuredCloneSafe(geometry.userData);
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    out.setAttribute(name, gatherAttribute(attr as AnyAttribute, newToOld));
  }
  for (const [name, list] of Object.entries(geometry.morphAttributes)) {
    (out.morphAttributes as Record<string, AnyAttribute[]>)[name] = list.map((attr) =>
      gatherAttribute(attr as AnyAttribute, newToOld),
    );
  }
  out.morphTargetsRelative = geometry.morphTargetsRelative;
  const IndexArray = newToOld.length > 65535 ? Uint32Array : Uint16Array;
  out.setIndex(new BufferAttribute(IndexArray === Uint32Array ? index : Uint16Array.from(index), 1));

  if (hasGroups) {
    let runStart = 0;
    for (let i = 1; i <= selected.length; i++) {
      const prev = triMats[selected[i - 1]];
      const cur = i < selected.length ? triMats[selected[i]] : Number.NaN;
      if (cur !== prev) {
        if (prev >= 0) out.addGroup(runStart * 3, (i - runStart) * 3, prev);
        runStart = i;
      }
    }
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? {})) as T;
  }
}

/** Splits a geometry into (selected, remaining) by triangle mask. Either may be empty (0 triangles). */
export function splitTriangles(
  geometry: BufferGeometry,
  mask: Uint8Array,
): { selected: BufferGeometry; remaining: BufferGeometry } {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1;
  return { selected: extractTriangles(geometry, mask), remaining: extractTriangles(geometry, inverse) };
}

/** One geometry per component id, in component-id order. */
export function separateByComponents(
  geometry: BufferGeometry,
  triangleComponent: Uint32Array,
  componentCount: number,
): BufferGeometry[] {
  const result: BufferGeometry[] = [];
  for (let c = 0; c < componentCount; c++) {
    const mask = new Uint8Array(triangleComponent.length);
    for (let t = 0; t < triangleComponent.length; t++) if (triangleComponent[t] === c) mask[t] = 1;
    result.push(extractTriangles(geometry, mask));
  }
  return result;
}

export function maskFromTriangles(triCount: number, triangles: Iterable<number>): Uint8Array {
  const mask = new Uint8Array(triCount);
  for (const t of triangles) if (t >= 0 && t < triCount) mask[t] = 1;
  return mask;
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}
