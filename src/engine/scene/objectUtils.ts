import {
  Box3,
  type BufferGeometry,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  Texture,
  Vector3,
} from 'three';
import { createId } from '../../utils/ids';

export const ROOT_ID = 'root';

/** userData keys used by Zino3D (all JSON-safe, so they survive glTF `extras`). */
export const UD = {
  id: 'zinoId',
  locked: 'zinoLocked',
  hidden: 'zinoHidden',
  collection: 'zinoCollection',
} as const;

export function getId(object: Object3D): string {
  return object.userData[UD.id] as string;
}

export function isMesh(object: Object3D | null | undefined): object is Mesh {
  return !!object && (object as Mesh).isMesh === true;
}

export function hasGeometry(object: Object3D): object is Object3D & { geometry: BufferGeometry } {
  return (object as { geometry?: BufferGeometry }).geometry?.isBufferGeometry === true;
}

export function isCollection(object: Object3D): boolean {
  return object.userData[UD.collection] === true;
}

export function objectMaterials(object: Object3D): Material[] {
  const m = (object as { material?: Material | Material[] }).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

/** Assigns fresh ids to an object tree (used for duplicates) or fills in missing ids. */
export function assignIds(object: Object3D, mode: 'missing' | 'fresh', taken?: Set<string>): void {
  object.traverse((o) => {
    const current = o.userData[UD.id];
    if (
      mode === 'fresh' ||
      typeof current !== 'string' ||
      current.length === 0 ||
      (taken && taken.has(current))
    ) {
      o.userData[UD.id] = createId('obj');
    }
    taken?.add(o.userData[UD.id] as string);
  });
}

export function insertChild(parent: Object3D, child: Object3D, index?: number): void {
  if (child.parent) child.parent.remove(child);
  parent.add(child);
  if (index !== undefined && index >= 0 && index < parent.children.length - 1) {
    parent.children.pop();
    parent.children.splice(index, 0, child);
  }
}

export function isDescendantOf(object: Object3D, ancestor: Object3D): boolean {
  let p = object.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

export function setLocalMatrix(object: Object3D, matrix: Matrix4): void {
  matrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
  object.updateMatrixWorld(true);
}

export function worldBounds(objects: Object3D[]): Box3 {
  const box = new Box3();
  for (const o of objects) {
    o.updateWorldMatrix(true, true);
    box.expandByObject(o, true);
  }
  return box;
}

/** Bounding box of an object's descendants expressed in the object's own local space. */
export function localBounds(object: Object3D): Box3 {
  object.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(object.matrixWorld).invert();
  const box = new Box3();
  const tmp = new Box3();
  object.traverse((o) => {
    if (!hasGeometry(o)) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) return;
    tmp.copy(g.boundingBox).applyMatrix4(new Matrix4().multiplyMatrices(inv, o.matrixWorld));
    box.union(tmp);
  });
  return box;
}

export function materialTextures(material: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(material)) {
    if (value instanceof Texture) out.push(value);
  }
  return out;
}

export function collectResources(
  root: Object3D,
  into: { geometries: Set<BufferGeometry>; materials: Set<Material> },
): void {
  root.traverse((o) => {
    if (hasGeometry(o)) into.geometries.add(o.geometry);
    for (const m of objectMaterials(o)) into.materials.add(m);
  });
}

export function worldPosition(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  return new Vector3().setFromMatrixPosition(object.matrixWorld);
}

export function displayType(object: Object3D): string {
  if (isCollection(object)) return 'Collection';
  if ((object as Mesh).isMesh)
    return (object as { isSkinnedMesh?: boolean }).isSkinnedMesh ? 'Skinned Mesh' : 'Mesh';
  if ((object as { isLight?: boolean }).isLight) return 'Light';
  if ((object as { isCamera?: boolean }).isCamera) return 'Camera';
  if ((object as { isLine?: boolean }).isLine) return 'Line';
  if ((object as { isPoints?: boolean }).isPoints) return 'Points';
  if ((object as { isBone?: boolean }).isBone) return 'Bone';
  return 'Group';
}
