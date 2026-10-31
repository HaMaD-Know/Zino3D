import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { mergeGeometries as threeMerge } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeConnectivity } from '../src/engine/geometry/connectivity';
import {
  readPositions,
  triangleCount,
  triangleMaterialIndices,
  triangleVertexIndices,
} from '../src/engine/geometry/attributes';
import { extractTriangles, separateByComponents, splitTriangles } from '../src/engine/geometry/extract';
import {
  cleanupGeometry,
  flipNormals,
  mergeGeometries,
  recalculateNormals,
  weldVertices,
} from '../src/engine/geometry/operations';
import { analyzeGeometry } from '../src/engine/geometry/analysis';
import { canonicalizeVertices } from '../src/engine/geometry/spatialHash';

function twoBoxes(): BufferGeometry {
  const a = new BoxGeometry(1, 1, 1);
  const b = new BoxGeometry(1, 1, 1);
  b.translate(3, 0, 0);
  return threeMerge([a, b], true)!;
}

function connectivityOf(g: BufferGeometry, weld = true) {
  return computeConnectivity(
    { positions: readPositions(g), triangles: triangleVertexIndices(g) },
    { tolerance: 1e-6, weld },
  );
}

describe('spatial hash canonicalization', () => {
  it('merges coincident vertices within tolerance only', () => {
    const p = new Float32Array([0, 0, 0, 0.0000001, 0, 0, 1, 0, 0, 0, 0, 0.5]);
    const c = canonicalizeVertices(p, 1e-5);
    expect(c.count).toBe(3);
    expect(c.ids[0]).toBe(c.ids[1]);
    expect(c.ids[2]).not.toBe(c.ids[0]);
  });
});

describe('connectivity', () => {
  it('treats a box split at UV seams as one component when welding', () => {
    const box = new BoxGeometry(1, 1, 1);
    expect(connectivityOf(box).componentCount).toBe(1);
    // Without position welding, each face of BoxGeometry is its own island.
    expect(connectivityOf(box, false).componentCount).toBe(6);
  });

  it('finds two components in indexed and non-indexed geometry', () => {
    const g = twoBoxes();
    const indexed = connectivityOf(g);
    expect(indexed.componentCount).toBe(2);
    const nonIndexed = connectivityOf(g.toNonIndexed());
    expect(nonIndexed.componentCount).toBe(2);
    expect(indexed.components[0].triangleCount).toBe(12);
    expect(indexed.components[1].min[0]).toBeCloseTo(2.5);
  });

  it('assigns stable component ids in order of first triangle', () => {
    const g = twoBoxes();
    const r = connectivityOf(g);
    expect(r.triangleComponent[0]).toBe(0);
    expect(r.triangleComponent[r.triangleComponent.length - 1]).toBe(1);
  });
});

describe('triangle extraction', () => {
  it('preserves attributes, groups and material assignment', () => {
    const box = new BoxGeometry(1, 1, 1); // 6 groups, materialIndex 0..5
    const mats = triangleMaterialIndices(box);
    const mask = new Uint8Array(triangleCount(box));
    for (let t = 0; t < mask.length; t++) if (mats[t] === 2 || mats[t] === 4) mask[t] = 1;
    const out = extractTriangles(box, mask);
    expect(triangleCount(out)).toBe(4);
    expect(Object.keys(out.attributes).sort()).toEqual(['normal', 'position', 'uv']);
    expect(out.groups.map((g) => g.materialIndex)).toEqual([2, 4]);
    expect(out.getAttribute('position').count).toBe(8);
    expect(out.boundingBox).not.toBeNull();
    // UVs copied exactly
    const srcUv = box.getAttribute('uv');
    const outUv = out.getAttribute('uv');
    const firstOld = triangleVertexIndices(box)[[...mask].indexOf(1) * 3];
    expect(outUv.getX(0)).toBe(srcUv.getX(firstOld));
  });

  it('preserves non-float storage types', () => {
    const g = new BoxGeometry(1, 1, 1);
    const uv = g.getAttribute('uv');
    const quantized = new Uint16Array(uv.count * 2).map((_, i) => Math.round(uv.array[i] * 65535));
    g.setAttribute('uv', new BufferAttribute(quantized, 2, true));
    const out = extractTriangles(g, new Uint8Array(triangleCount(g)).fill(1));
    expect(out.getAttribute('uv').array).toBeInstanceOf(Uint16Array);
    expect(out.getAttribute('uv').normalized).toBe(true);
  });

  it('splits into selected and remaining parts', () => {
    const g = twoBoxes();
    const conn = connectivityOf(g);
    const mask = new Uint8Array(conn.triangleComponent.length);
    conn.triangleComponent.forEach((c, t) => (mask[t] = c === 1 ? 1 : 0));
    const { selected, remaining } = splitTriangles(g, mask);
    expect(triangleCount(selected)).toBe(12);
    expect(triangleCount(remaining)).toBe(12);
    selected.computeBoundingBox();
    expect(selected.boundingBox!.min.x).toBeCloseTo(2.5);
    const parts = separateByComponents(g, conn.triangleComponent, conn.componentCount);
    expect(parts).toHaveLength(2);
  });
});

describe('mesh operations', () => {
  it('flips normals and winding', () => {
    const plane = new PlaneGeometry(1, 1);
    const flipped = flipNormals(plane);
    expect(flipped.getAttribute('normal').getZ(0)).toBe(-1);
    const tri = triangleVertexIndices(flipped);
    const p = flipped.getAttribute('position');
    const a = new Vector3().fromBufferAttribute(p, tri[0]);
    const b = new Vector3().fromBufferAttribute(p, tri[1]);
    const c = new Vector3().fromBufferAttribute(p, tri[2]);
    const n = b.sub(a).cross(c.sub(a));
    expect(n.z).toBeLessThan(0);
  });

  it('recalculates normals (smooth and flat)', () => {
    const box = new BoxGeometry(1, 1, 1);
    expect(recalculateNormals(box, 'smooth').getAttribute('normal').count).toBe(24);
    const flat = recalculateNormals(box, 'flat');
    expect(flat.getAttribute('normal').count).toBe(36);
    expect(flat.groups).toHaveLength(6);
  });

  it('welds duplicate vertices while keeping seams', () => {
    const nonIndexed = new BoxGeometry(1, 1, 1).toNonIndexed();
    expect(nonIndexed.getAttribute('position').count).toBe(36);
    const r = weldVertices(nonIndexed, 1e-4);
    expect(r.geometry.getAttribute('position').count).toBe(24);
  });

  it('removes degenerate triangles', () => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0]), 3),
    );
    const r = cleanupGeometry(g, 1e-6);
    expect(triangleCount(r.geometry)).toBe(1);
  });

  it('merges geometries with materials and baked transforms', () => {
    const red = new MeshStandardMaterial({ color: 'red' });
    const blue = new MeshStandardMaterial({ color: 'blue' });
    const r = mergeGeometries([
      { geometry: new BoxGeometry(1, 1, 1), matrix: new Matrix4(), materials: [red] },
      {
        geometry: new BoxGeometry(1, 1, 1),
        matrix: new Matrix4().makeTranslation(5, 0, 0),
        materials: [blue],
      },
    ]);
    expect(r.materials).toEqual([red, blue]);
    expect(r.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    r.geometry.computeBoundingBox();
    expect(r.geometry.boundingBox!.max.x).toBeCloseTo(5.5);
    expect(triangleCount(r.geometry)).toBe(24);
  });

  it('keeps faces outward when merging with a mirroring matrix', () => {
    const m = new MeshStandardMaterial();
    const r = mergeGeometries([
      { geometry: new PlaneGeometry(1, 1), matrix: new Matrix4().makeScale(-1, 1, 1), materials: [m] },
    ]);
    const tri = triangleVertexIndices(r.geometry);
    const p = r.geometry.getAttribute('position');
    const a = new Vector3().fromBufferAttribute(p, tri[0]);
    const b = new Vector3().fromBufferAttribute(p, tri[1]);
    const c = new Vector3().fromBufferAttribute(p, tri[2]);
    expect(b.sub(a).cross(c.sub(a)).z).toBeGreaterThan(0);
  });
});

describe('analysis', () => {
  it('reports closed and open meshes', () => {
    const box = analyzeGeometry(new BoxGeometry(1, 1, 1));
    expect(box.closed).toBe(true);
    expect(box.componentCount).toBe(1);
    const plane = analyzeGeometry(new PlaneGeometry(1, 1));
    expect(plane.closed).toBe(false);
    expect(plane.boundaryEdges).toBe(4);
  });
});

describe('edit-mode selection helpers', () => {
  it('selects linked, by material, inverts and converts between modes', async () => {
    const {
      getTopology,
      selectLinked,
      selectByMaterial,
      invertElementSelection,
      convertSelection,
      selectionFromTriangles,
      selectionToTriangleMask,
    } = await import('../src/engine/geometry/topology');
    const g = twoBoxes(); // 2 boxes, groups from merge (materialIndex 0 and 1)
    const topo = getTopology(g);
    const one = selectionFromTriangles(topo, 'face', [0]);
    const linked = selectLinked(topo, 'face', one);
    expect(linked.faces.size).toBe(12);
    const byMat = selectByMaterial(topo, 'face', 1);
    expect(byMat.faces.size).toBe(12);
    expect([...byMat.faces].every((f) => !linked.faces.has(f))).toBe(true);
    expect(invertElementSelection(topo, 'face', linked).faces.size).toBe(12);
    const verts = convertSelection(topo, 'face', 'vertex', linked);
    expect(verts.vertices.size).toBe(8); // welded cube corners
    const back = selectionToTriangleMask(topo, 'vertex', verts, 'contained');
    expect(back.reduce((s, v) => s + v, 0)).toBe(12);
    const edges = convertSelection(topo, 'vertex', 'edge', verts);
    expect(edges.edges.size).toBe(18); // 12 cube edges + 6 face diagonals
  });
});
