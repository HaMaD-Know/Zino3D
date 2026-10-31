import { BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute } from 'three';

export type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

type TypedArrayConstructor = new (length: number) => TypedArray;

function isInterleaved(attr: AnyAttribute): attr is InterleavedBufferAttribute {
  return (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
}

/** Returns the raw (not denormalized) storage array and the layout for an attribute. */
export function attributeLayout(attr: AnyAttribute): {
  array: TypedArray;
  stride: number;
  offset: number;
  itemSize: number;
  count: number;
} {
  if (isInterleaved(attr)) {
    return {
      array: attr.data.array as TypedArray,
      stride: attr.data.stride,
      offset: attr.offset,
      itemSize: attr.itemSize,
      count: attr.count,
    };
  }
  return {
    array: attr.array as TypedArray,
    stride: attr.itemSize,
    offset: 0,
    itemSize: attr.itemSize,
    count: attr.count,
  };
}

/**
 * Creates a new non-interleaved attribute containing the given source vertices, in order.
 * Raw component values are copied, so the storage type and normalization are preserved exactly.
 */
export function gatherAttribute(src: AnyAttribute, sourceVertices: ArrayLike<number>): BufferAttribute {
  const { array, stride, offset, itemSize } = attributeLayout(src);
  const Ctor = array.constructor as TypedArrayConstructor;
  const n = sourceVertices.length;
  const out = new Ctor(n * itemSize);
  for (let i = 0; i < n; i++) {
    const base = sourceVertices[i] * stride + offset;
    const o = i * itemSize;
    for (let c = 0; c < itemSize; c++) out[o + c] = array[base + c];
  }
  const attr = new BufferAttribute(out, itemSize, src.normalized);
  attr.name = src.name;
  if (!isInterleaved(src)) attr.gpuType = src.gpuType;
  return attr;
}

/** Reads positions into a contiguous Float32Array (denormalized, de-interleaved). */
export function readPositions(geometry: BufferGeometry): Float32Array {
  const pos = geometry.getAttribute('position') as AnyAttribute | undefined;
  if (!pos) return new Float32Array(0);
  if (!isInterleaved(pos) && pos.array instanceof Float32Array && pos.itemSize === 3 && !pos.normalized) {
    return pos.array;
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  return out;
}

export function triangleCount(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  const count = geometry.index ? geometry.index.count : pos.count;
  return Math.floor(count / 3);
}

/** Vertex index triples for every triangle (identity mapping for non-indexed geometry). */
export function triangleVertexIndices(geometry: BufferGeometry): Uint32Array {
  const t = triangleCount(geometry);
  const out = new Uint32Array(t * 3);
  const index = geometry.index;
  if (index) {
    const arr = index.array;
    for (let i = 0; i < t * 3; i++) out[i] = arr[i];
  } else {
    for (let i = 0; i < t * 3; i++) out[i] = i;
  }
  return out;
}

/**
 * Material index per triangle derived from geometry groups.
 * Without groups every triangle uses material 0. Triangles not covered by any group get -1
 * (three.js does not render them; they are preserved as-is).
 */
export function triangleMaterialIndices(geometry: BufferGeometry): Int32Array {
  const t = triangleCount(geometry);
  const out = new Int32Array(t);
  if (geometry.groups.length === 0) return out;
  out.fill(-1);
  for (const group of geometry.groups) {
    const start = Math.floor(group.start / 3);
    const end = Math.min(t, Math.floor((group.start + group.count) / 3));
    const material = group.materialIndex ?? 0;
    for (let tri = start; tri < end; tri++) out[tri] = material;
  }
  return out;
}

export function boundsDiagonal(positions: Float32Array): number {
  if (positions.length === 0) return 0;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/**
 * Default weld tolerance: one millionth of the bounding-box diagonal, so that float noise in exported
 * files merges while genuinely separate geometry stays separate.
 */
export function defaultWeldTolerance(positions: Float32Array): number {
  return Math.max(boundsDiagonal(positions) * 1e-6, 1e-9);
}
