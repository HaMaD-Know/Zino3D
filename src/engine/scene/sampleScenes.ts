import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function paint(name: string, color: string, metalness = 0.2, roughness = 0.5): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: new Color(color), metalness, roughness });
  m.name = name;
  return m;
}

/** Strips attributes so differently-generated primitives can be merged (all keep position/normal/uv). */
function prepare(g: BufferGeometry): BufferGeometry {
  for (const name of Object.keys(g.attributes))
    if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

export interface CarOptions {
  /** When true, every wheel is connected to the body by a bridging triangle (one connected mesh). */
  fusedWheels?: boolean;
}

/**
 * Builds a car-like test model as a SINGLE mesh (as many AI generators output): body, cabin and four
 * wheels, using two materials (paint, tyre). Wheels are disconnected components unless fused.
 */
export function createCarMesh(options: CarOptions = {}): Mesh {
  const body = prepare(new BoxGeometry(1.8, 0.5, 4, 2, 1, 4));
  body.translate(0, 0.65, 0);
  const cabin = prepare(new BoxGeometry(1.5, 0.45, 2, 1, 1, 2));
  cabin.translate(0, 1.12, -0.2);
  const bodyGeo = mergeGeometries([body, cabin])!;
  const wheels: BufferGeometry[] = [];
  for (const x of [-0.95, 0.95]) {
    for (const z of [-1.3, 1.3]) {
      const w = prepare(new CylinderGeometry(0.36, 0.36, 0.26, 20, 1));
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.36, z);
      wheels.push(w);
    }
  }
  const wheelGeo = mergeGeometries(wheels)!;
  const merged = mergeGeometries([bodyGeo, wheelGeo], true)!;
  if (options.fusedWheels) {
    // Connect each wheel's first vertex to two body vertices with a thin bridging triangle.
    const index = merged.index!;
    const bodyVerts = bodyGeo.getAttribute('position').count;
    const perWheel = wheels[0].getAttribute('position').count;
    const extra: number[] = [];
    for (let w = 0; w < 4; w++) extra.push(bodyVerts + w * perWheel, w * 4, w * 4 + 1);
    const arr = new Uint32Array(index.count + extra.length);
    arr.set(index.array as ArrayLike<number>);
    arr.set(extra, index.count);
    merged.setIndex(new BufferAttribute(arr, 1));
    const last = merged.groups[merged.groups.length - 1];
    last.count += extra.length;
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  const mesh = new Mesh(merged, [
    paint('Car Paint', '#c2410c', 0.6, 0.35),
    paint('Tyre Rubber', '#1f2023', 0, 0.9),
  ]);
  mesh.name = options.fusedWheels ? 'Car (fused wheels)' : 'Car';
  return mesh;
}

/** Sample project content: a car with loose wheels plus a few primitives. */
export function createSampleScene(): Object3D[] {
  const car = createCarMesh();
  const props = new Group();
  props.name = 'Props';
  const knot = new Mesh(new TorusKnotGeometry(0.4, 0.13, 128, 16), paint('Brushed Metal', '#b8bcc4', 1, 0.3));
  knot.name = 'Torus Knot';
  knot.position.set(3, 0.75, 0);
  const sphere = new Mesh(new SphereGeometry(0.45, 32, 16), paint('Blue Plastic', '#2f6fd1', 0, 0.4));
  sphere.name = 'Sphere';
  sphere.position.set(-3, 0.45, 0.8);
  const cube = new Mesh(new BoxGeometry(0.8, 0.8, 0.8), paint('Concrete', '#8a8f98', 0, 0.85));
  cube.name = 'Cube';
  cube.position.set(-3, 0.4, -1);
  props.add(knot, sphere, cube);
  return [car, props];
}
