import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCarMesh } from '../src/engine/scene/sampleScenes';
import { computeConnectivity } from '../src/engine/geometry/connectivity';
import { readPositions, triangleVertexIndices } from '../src/engine/geometry/attributes';
import { analyzeMeshWheels } from '../src/engine/geometry/wheelDetection';
import {
  estimateWheelFromTap,
  trianglesInCylinder,
  worldPositions,
} from '../src/engine/geometry/wheelPicker';

function analyze(mesh: Mesh) {
  mesh.updateMatrixWorld(true);
  const positions = readPositions(mesh.geometry);
  const triangles = triangleVertexIndices(mesh.geometry);
  const conn = computeConnectivity({ positions, triangles }, { tolerance: 1e-6 });
  return analyzeMeshWheels({
    positions,
    triangles,
    triangleComponent: conn.triangleComponent,
    componentCount: conn.componentCount,
    matrix: mesh.matrixWorld.elements,
  });
}

const strip = (g: BufferGeometry) => {
  for (const k of Object.keys(g.attributes))
    if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
};

/** Car whose wheels are each a tyre (torus) plus a separate rim disc: 2 loose parts per wheel. */
function twoPieceWheelCar(): Mesh {
  const parts: BufferGeometry[] = [];
  const body = strip(new BoxGeometry(1.8, 0.6, 4.2));
  body.translate(0, 0.75, 0);
  parts.push(body);
  for (const x of [-0.95, 0.95])
    for (const z of [-1.35, 1.35]) {
      const tyre = strip(new TorusGeometry(0.28, 0.09, 12, 32));
      tyre.rotateY(Math.PI / 2);
      tyre.translate(x, 0.37, z);
      const rim = strip(new CylinderGeometry(0.2, 0.2, 0.08, 24));
      rim.rotateZ(Math.PI / 2);
      rim.translate(x, 0.37, z);
      parts.push(tyre, rim);
    }
  return new Mesh(mergeGeometries(parts)!, new MeshStandardMaterial());
}

describe('orientation-independent wheel analysis', () => {
  it('finds the wheels of a car turned 30° about the vertical axis', () => {
    const car = createCarMesh();
    car.rotation.y = Math.PI / 6;
    const r = analyze(car);
    expect(r.upAxis).toBe(1);
    expect(
      r.groups
        .slice(0, 4)
        .map((g) => g.anchorId)
        .sort(),
    ).toEqual([2, 3, 4, 5]);
    expect(Math.abs(Math.abs(r.yawDegrees) % 90)).not.toBe(0);
  });

  it('finds wheels of a Z-up car at an arbitrary heading', () => {
    const car = createCarMesh();
    car.rotation.set(Math.PI / 2, 0, 0.7, 'ZYX');
    const r = analyze(car);
    expect(r.upAxis).toBe(2);
    expect(
      r.groups
        .slice(0, 4)
        .map((g) => g.anchorId)
        .sort(),
    ).toEqual([2, 3, 4, 5]);
  });

  it('groups tyre and rim pieces into one wheel assembly each', () => {
    const car = twoPieceWheelCar();
    const r = analyze(car);
    const wheels = r.groups.filter((g) => g.score >= 0.55);
    expect(wheels).toHaveLength(4);
    for (const g of wheels) expect(g.componentIds).toHaveLength(2);
    expect(new Set(wheels.flatMap((g) => g.componentIds)).size).toBe(8);
    expect(wheels.flatMap((g) => g.componentIds)).not.toContain(0); // body never grouped
  });
});

describe('fused wheel picker', () => {
  it('selects one fused wheel from a tap on its side', () => {
    const car = createCarMesh({ fusedWheels: true });
    car.position.set(5, 0, -3);
    car.rotation.y = 0.4;
    car.updateMatrixWorld(true);
    const positions = readPositions(car.geometry);
    const triangles = triangleVertexIndices(car.geometry);
    const world = worldPositions(positions, car.matrixWorld.elements);
    // Tap the outer face of the front-right wheel, slightly off-centre (users won't hit it exactly).
    const tap = new Vector3(0.95 + 0.13, 0.36 + 0.05, 1.3 - 0.04).applyMatrix4(car.matrixWorld);
    const cyl = estimateWheelFromTap({ world, triangles }, tap.toArray() as [number, number, number], 1);
    expect(cyl.radius).toBeGreaterThan(0.3);
    expect(cyl.radius).toBeLessThan(0.45);
    const mask = trianglesInCylinder({ world, triangles }, cyl);
    // Ground truth: triangles whose centroid lies inside the true wheel (local space).
    let wheelTotal = 0,
      wheelHit = 0,
      other = 0;
    for (let t = 0; t < triangles.length / 3; t++) {
      const c = new Vector3();
      for (let k = 0; k < 3; k++) c.add(new Vector3().fromArray(positions, triangles[t * 3 + k] * 3));
      c.divideScalar(3);
      const inWheel = c.x > 0.8 && c.x < 1.1 && Math.hypot(c.y - 0.36, c.z - 1.3) < 0.37;
      if (inWheel) {
        wheelTotal++;
        if (mask[t]) wheelHit++;
      } else if (mask[t]) other++;
    }
    expect(wheelTotal).toBeGreaterThan(50);
    expect(wheelHit / wheelTotal).toBeGreaterThan(0.95);
    expect(other).toBeLessThan(wheelTotal * 0.5);
  });
});
