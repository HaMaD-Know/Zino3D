import { BufferAttribute, BufferGeometry, Matrix4, Vector3, type Material, type Mesh } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  type AnyAttribute,
  attributeLayout,
  readPositions,
  triangleCount,
  triangleMaterialIndices,
  triangleVertexIndices,
} from './attributes';
import { canonicalizeVertices } from './spatialHash';
import { countMask, extractTriangles } from './extract';

export interface OperationReport {
  geometry: BufferGeometry;
  messages: string[];
}

/** Reverses triangle winding and negates normals (and tangent xyz) so the mesh faces the other way. */
export function flipNormals(geometry: BufferGeometry): BufferGeometry {
  const all = new Uint8Array(triangleCount(geometry)).fill(1);
  const out = extractTriangles(geometry, all, { flipWinding: true });
  for (const name of ['normal', 'tangent']) {
    const attr = out.getAttribute(name) as BufferAttribute | undefined;
    if (!attr) continue;
    const arr = attr.array;
    // Only xyz is negated; tangent.w (handedness) is left unchanged.
    for (let i = 0; i < attr.count; i++) {
      for (let c = 0; c < 3; c++) arr[i * attr.itemSize + c] = -arr[i * attr.itemSize + c];
    }
    attr.needsUpdate = true;
  }
  return out;
}

/**
 * Recomputes vertex normals.
 * - 'smooth': averages normals across vertices that share an index (seams stay sharp).
 * - 'flat': every triangle gets its own face normal (geometry becomes non-indexed internally,
 *   then re-indexed with one vertex per corner).
 */
export function recalculateNormals(
  geometry: BufferGeometry,
  mode: 'smooth' | 'flat' = 'smooth',
): BufferGeometry {
  if (mode === 'flat') {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    nonIndexed.deleteAttribute('normal');
    nonIndexed.computeVertexNormals();
    const all = new Uint8Array(triangleCount(nonIndexed)).fill(1);
    // toNonIndexed keeps groups in vertex units, extractTriangles re-indexes and keeps groups.
    const out = extractTriangles(nonIndexed, all);
    nonIndexed.dispose();
    return out;
  }
  const out = geometry.clone();
  out.deleteAttribute('normal');
  out.computeVertexNormals();
  return out;
}

/**
 * Merges vertices whose attributes are all within `tolerance` (three.js mergeVertices).
 * Because every attribute must match, UV and normal seams are preserved.
 */
export function weldVertices(geometry: BufferGeometry, tolerance: number): OperationReport {
  const before = geometry.getAttribute('position')?.count ?? 0;
  const out = mergeVertices(geometry.clone(), tolerance);
  const after = out.getAttribute('position')?.count ?? 0;
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return {
    geometry: out,
    messages: [`Welded ${before - after} vertices (${before} → ${after}).`],
  };
}

function triangleArea2(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[a * 3],
    ay = p[a * 3 + 1],
    az = p[a * 3 + 2];
  const ux = p[b * 3] - ax,
    uy = p[b * 3 + 1] - ay,
    uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax,
    vy = p[c * 3 + 1] - ay,
    vz = p[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy,
    cy = uz * vx - ux * vz,
    cz = ux * vy - uy * vx;
  return Math.hypot(cx, cy, cz);
}

/** Finds degenerate triangles: repeated (welded) corners or near-zero area. */
export function findDegenerateTriangles(geometry: BufferGeometry, tolerance: number): Uint8Array {
  const positions = readPositions(geometry);
  const tri = triangleVertexIndices(geometry);
  const t = tri.length / 3;
  const canon = canonicalizeVertices(positions, tolerance);
  const mask = new Uint8Array(t);
  const areaEps = tolerance * tolerance;
  for (let i = 0; i < t; i++) {
    const a = tri[i * 3],
      b = tri[i * 3 + 1],
      c = tri[i * 3 + 2];
    const ca = canon.ids[a],
      cb = canon.ids[b],
      cc = canon.ids[c];
    if (ca === cb || cb === cc || ca === cc || triangleArea2(positions, a, b, c) <= areaEps) mask[i] = 1;
  }
  return mask;
}

/** Removes degenerate triangles and unused vertices. */
export function cleanupGeometry(geometry: BufferGeometry, tolerance: number): OperationReport {
  const degenerate = findDegenerateTriangles(geometry, tolerance);
  const removed = countMask(degenerate);
  const keep = new Uint8Array(degenerate.length);
  for (let i = 0; i < keep.length; i++) keep[i] = degenerate[i] ? 0 : 1;
  const before = geometry.getAttribute('position')?.count ?? 0;
  const out = extractTriangles(geometry, keep);
  const after = out.getAttribute('position')?.count ?? 0;
  return {
    geometry: out,
    messages: [`Removed ${removed} degenerate triangle(s) and ${before - after} unused vertex/vertices.`],
  };
}

export interface MergeSource {
  geometry: BufferGeometry;
  /** Matrix that maps the source geometry into the target object's local space. */
  matrix: Matrix4;
  materials: Material[];
}

export interface MergeResult {
  geometry: BufferGeometry;
  materials: Material[];
  messages: string[];
}

/**
 * Bakes several geometries into one geometry in a common space with one group per material.
 * Missing normals are computed, missing UVs/colors are filled with defaults (reported), and
 * attributes that are not present on every source are dropped (reported).
 */
export function mergeGeometries(sources: MergeSource[]): MergeResult {
  if (sources.length === 0) throw new Error('Nothing to merge.');
  const messages: string[] = [];
  const allNames = new Set<string>();
  for (const s of sources) for (const name of Object.keys(s.geometry.attributes)) allNames.add(name);
  const fillable = new Set(['normal', 'uv', 'color']);
  const names = [...allNames].filter((name) => {
    const everywhere = sources.every((s) => s.geometry.getAttribute(name));
    if (everywhere || fillable.has(name)) return true;
    messages.push(`Attribute "${name}" was not present on every mesh and was dropped.`);
    return false;
  });
  if (sources.some((s) => Object.keys(s.geometry.morphAttributes).length > 0)) {
    messages.push('Morph targets are not preserved when merging.');
  }

  const materials: Material[] = [];
  const materialIndex = new Map<Material, number>();
  const prepared: Array<{ geometry: BufferGeometry; triMaterial: Int32Array }> = [];

  for (const source of sources) {
    const g = source.geometry.clone();
    g.morphAttributes = {};
    g.applyMatrix4(source.matrix);
    const triMats = triangleMaterialIndices(source.geometry);
    const mapped = new Int32Array(triMats.length);
    for (let t = 0; t < triMats.length; t++) {
      const local = triMats[t];
      const mat = local >= 0 ? source.materials[Math.min(local, source.materials.length - 1)] : undefined;
      if (!mat) {
        mapped[t] = -1;
        continue;
      }
      let idx = materialIndex.get(mat);
      if (idx === undefined) {
        idx = materials.length;
        materials.push(mat);
        materialIndex.set(mat, idx);
      }
      mapped[t] = idx;
    }
    let geometry = g;
    if (source.matrix.determinant() < 0) {
      // Mirroring transform: restore front-face orientation.
      const all = new Uint8Array(triangleCount(g)).fill(1);
      geometry = extractTriangles(g, all, { flipWinding: true });
      g.dispose();
    }
    if (names.includes('normal') && !geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
      messages.push('Normals were computed for a mesh that had none.');
    }
    for (const name of names) {
      if (geometry.getAttribute(name)) continue;
      if (name === 'uv') {
        geometry.setAttribute(
          'uv',
          new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2),
        );
        messages.push('A mesh without UV coordinates received zero UVs.');
      } else if (name === 'color') {
        geometry.setAttribute(
          'color',
          new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(1), 3),
        );
        messages.push('A mesh without vertex colors received white vertex colors.');
      }
    }
    prepared.push({ geometry, triMaterial: mapped });
  }

  // Concatenate attributes (as float unless all sources share the same storage type).
  const out = new BufferGeometry();
  let totalVertices = 0;
  for (const p of prepared) totalVertices += p.geometry.getAttribute('position').count;
  for (const name of names) {
    const attrs = prepared.map((p) => p.geometry.getAttribute(name) as AnyAttribute);
    const itemSize = attrs[0].itemSize;
    if (attrs.some((a) => a.itemSize !== itemSize)) {
      messages.push(`Attribute "${name}" has mismatched sizes and was dropped.`);
      continue;
    }
    const sameType = attrs.every(
      (a) =>
        attributeLayout(a).array.constructor === attributeLayout(attrs[0]).array.constructor &&
        a.normalized === attrs[0].normalized,
    );
    if (sameType) {
      const Ctor = attributeLayout(attrs[0]).array.constructor as new (n: number) => Float32Array;
      const arr = new Ctor(totalVertices * itemSize);
      let offset = 0;
      for (const a of attrs) {
        const { array, stride, offset: off } = attributeLayout(a);
        for (let i = 0; i < a.count; i++)
          for (let c = 0; c < itemSize; c++) arr[(offset + i) * itemSize + c] = array[i * stride + off + c];
        offset += a.count;
      }
      out.setAttribute(name, new BufferAttribute(arr, itemSize, attrs[0].normalized));
    } else {
      const arr = new Float32Array(totalVertices * itemSize);
      let offset = 0;
      for (const a of attrs) {
        for (let i = 0; i < a.count; i++)
          for (let c = 0; c < itemSize; c++) arr[(offset + i) * itemSize + c] = a.getComponent(i, c);
        offset += a.count;
      }
      out.setAttribute(name, new BufferAttribute(arr, itemSize, false));
    }
  }

  // Triangles sorted by material for contiguous groups.
  const tris: Array<{ a: number; b: number; c: number; m: number; order: number }> = [];
  let vertexOffset = 0;
  let order = 0;
  for (const p of prepared) {
    const tv = triangleVertexIndices(p.geometry);
    for (let t = 0; t < tv.length / 3; t++) {
      tris.push({
        a: tv[t * 3] + vertexOffset,
        b: tv[t * 3 + 1] + vertexOffset,
        c: tv[t * 3 + 2] + vertexOffset,
        m: p.triMaterial[t],
        order: order++,
      });
    }
    vertexOffset += p.geometry.getAttribute('position').count;
    p.geometry.dispose();
  }
  tris.sort((x, y) => (x.m < 0 ? 1e9 : x.m) - (y.m < 0 ? 1e9 : y.m) || x.order - y.order);
  const IndexArray = totalVertices > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(tris.length * 3);
  tris.forEach((t, i) => {
    index[i * 3] = t.a;
    index[i * 3 + 1] = t.b;
    index[i * 3 + 2] = t.c;
  });
  out.setIndex(new BufferAttribute(index, 1));
  let runStart = 0;
  for (let i = 1; i <= tris.length; i++) {
    const prev = tris[i - 1].m;
    const cur = i < tris.length ? tris[i].m : Number.NaN;
    if (cur !== prev) {
      if (prev >= 0) out.addGroup(runStart * 3, (i - runStart) * 3, prev);
      runStart = i;
    }
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return { geometry: out, materials, messages: [...new Set(messages)] };
}

/** Translates geometry vertices by -offset (used for origin changes). Returns a new geometry. */
export function translateGeometry(geometry: BufferGeometry, offset: Vector3): BufferGeometry {
  const out = geometry.clone();
  out.translate(-offset.x, -offset.y, -offset.z);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Bakes a matrix into a copy of the geometry, keeping front faces correct for mirroring matrices. */
export function bakeMatrix(geometry: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const g = geometry.clone();
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {
    const flipped = extractTriangles(g, new Uint8Array(triangleCount(g)).fill(1), { flipWinding: true });
    g.dispose();
    flipped.computeBoundingBox();
    flipped.computeBoundingSphere();
    return flipped;
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function meshMaterials(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
