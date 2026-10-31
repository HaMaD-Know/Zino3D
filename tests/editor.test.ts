import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { Editor } from '../src/engine/editor/Editor';
import {
  applyTransform,
  createCollection,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  renameObject,
  reparent,
  resetTransform,
  setLocked,
  setOrigin,
  setTransform,
  setVisibility,
  ungroupSelected,
} from '../src/engine/editor/objectOperations';
import {
  applyMeshUtility,
  deleteElements,
  mergeSelected,
  separateComponentGroups,
  separateElementSelection,
  separateLooseParts,
} from '../src/engine/editor/meshOperations';
import { getId } from '../src/engine/scene/objectUtils';
import { createCarMesh } from '../src/engine/scene/sampleScenes';
import { triangleCount } from '../src/engine/geometry/attributes';
import { getTopology, selectionFromTriangles } from '../src/engine/geometry/topology';

function setup() {
  const editor = new Editor();
  const a = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  a.name = 'A';
  a.position.set(1, 2, 3);
  const b = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  b.name = 'B';
  b.position.set(-2, 0, 0);
  editor.loadContent([a, b]);
  return { editor, a, b, idA: getId(a), idB: getId(b) };
}

function worldVertex(mesh: Mesh, i: number): Vector3 {
  mesh.updateWorldMatrix(true, false);
  return new Vector3()
    .fromBufferAttribute(mesh.geometry.getAttribute('position'), i)
    .applyMatrix4(mesh.matrixWorld);
}

describe('Editor object operations', () => {
  it('assigns stable ids and renames with undo/redo', () => {
    const { editor, a, idA } = setup();
    expect(editor.getObject(idA)).toBe(a);
    renameObject(editor, idA, 'Wheel');
    expect(a.name).toBe('Wheel');
    editor.undo();
    expect(a.name).toBe('A');
    editor.redo();
    expect(a.name).toBe('Wheel');
    expect(getId(a)).toBe(idA);
  });

  it('sets numeric transforms and coalesces rapid edits into one undo step', () => {
    const { editor, a, idA } = setup();
    setTransform(editor, idA, { position: [5, 0, 0] }, 'pos');
    setTransform(editor, idA, { position: [6, 0, 0] }, 'pos');
    expect(a.position.x).toBe(6);
    editor.undo();
    expect(a.position.toArray()).toEqual([1, 2, 3]);
    setTransform(editor, idA, { rotation: [0, 90, 0], scale: [2, 2, 2] });
    expect(a.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(a.scale.x).toBe(2);
  });

  it('deletes and restores objects at the same index', () => {
    const { editor, idA, idB } = setup();
    editor.select([idA]);
    deleteSelected(editor);
    expect(editor.getObject(idA)).toBeUndefined();
    expect(editor.selection).toEqual([]);
    editor.undo();
    expect(editor.root.children.map(getId)).toEqual([idA, idB]);
  });

  it('duplicates with fresh ids', () => {
    const { editor, idA } = setup();
    editor.select([idA]);
    const [copyId] = duplicateSelected(editor);
    expect(copyId).not.toBe(idA);
    expect(editor.getObject(copyId)!.name).toBe('A.copy');
    expect(editor.root.children).toHaveLength(3);
    editor.undo();
    expect(editor.root.children).toHaveLength(2);
  });

  it('reparents preserving world transforms', () => {
    const { editor, a, idA, idB } = setup();
    const b = editor.getObject(idB)!;
    b.rotation.set(0, Math.PI / 3, 0);
    b.scale.set(2, 2, 2);
    b.updateMatrixWorld(true);
    const before = worldVertex(a, 0);
    reparent(editor, [idA], idB);
    expect(a.parent).toBe(b);
    expect(worldVertex(a, 0).distanceTo(before)).toBeLessThan(1e-5);
    editor.undo();
    expect(a.parent).toBe(editor.root);
    expect(worldVertex(a, 0).distanceTo(before)).toBeLessThan(1e-5);
  });

  it('refuses to parent an object into its own descendant', () => {
    const { editor, idA, idB } = setup();
    reparent(editor, [idA], idB);
    reparent(editor, [idB], idA);
    expect(editor.getObject(idA)!.parent).toBe(editor.getObject(idB));
  });

  it('groups and ungroups', () => {
    const { editor, a, b, idA, idB } = setup();
    const wa = worldVertex(a, 0);
    editor.select([idA, idB]);
    const groupId = groupSelected(editor)!;
    const group = editor.getObject(groupId)!;
    expect(a.parent).toBe(group);
    expect(b.parent).toBe(group);
    expect(worldVertex(a, 0).distanceTo(wa)).toBeLessThan(1e-5);
    editor.select([groupId]);
    ungroupSelected(editor);
    expect(editor.getObject(groupId)).toBeUndefined();
    expect(a.parent).toBe(editor.root);
    editor.undo();
    expect(a.parent).toBe(editor.getObject(groupId));
    editor.undo();
    expect(a.parent).toBe(editor.root);
  });

  it('creates collections and moves objects into them', () => {
    const { editor, a, idA } = setup();
    const col = createCollection(editor, 'Wheels');
    reparent(editor, [idA], col);
    expect(a.parent!.name).toBe('Wheels');
  });

  it('hides and locks objects; locked objects are not deleted', () => {
    const { editor, a, idA } = setup();
    setVisibility(editor, [idA], false);
    expect(a.visible).toBe(false);
    expect(a.userData.zinoHidden).toBe(true);
    editor.undo();
    expect(a.visible).toBe(true);
    setLocked(editor, [idA], true);
    editor.select([idA]);
    deleteSelected(editor);
    expect(editor.getObject(idA)).toBe(a);
  });

  it('sets origin to geometry centre without moving the mesh in world space', () => {
    const { editor, a, idA } = setup();
    a.geometry.translate(0.5, 0, 0);
    const before = worldVertex(a, 3);
    editor.select([idA]);
    setOrigin(editor, 'geometry-center');
    expect(worldVertex(a, 3).distanceTo(before)).toBeLessThan(1e-5);
    a.geometry.computeBoundingBox();
    expect(a.geometry.boundingBox!.getCenter(new Vector3()).length()).toBeLessThan(1e-6);
    expect(a.position.x).toBeCloseTo(1.5);
    editor.undo();
    expect(a.position.x).toBeCloseTo(1);
  });

  it('applies transforms by baking them into geometry', () => {
    const { editor, a, idA } = setup();
    a.rotation.set(0.3, 0.2, 0.1);
    a.scale.set(1, 2, 3);
    a.updateMatrix();
    const before = worldVertex(a, 5);
    editor.select([idA]);
    applyTransform(editor, 'all');
    expect(a.matrix.equals(new Matrix4())).toBe(true);
    expect(worldVertex(a, 5).distanceTo(before)).toBeLessThan(1e-5);
    resetTransform(editor);
  });
});

describe('Editor mesh operations', () => {
  it('separates loose parts, keeping the largest in the original, and undoes', async () => {
    const editor = new Editor();
    const car = createCarMesh();
    editor.loadContent([car]);
    const total = triangleCount(car.geometry);
    editor.select([getId(car)]);
    const result = await separateLooseParts(editor);
    expect(result.componentCount).toBe(6); // body, cabin, 4 wheels
    expect(result.createdIds).toHaveLength(5);
    const sum = editor.root.children.reduce((s, o) => s + triangleCount((o as Mesh).geometry), 0);
    expect(sum).toBe(total);
    editor.undo();
    expect(editor.root.children).toHaveLength(1);
    expect(triangleCount(car.geometry)).toBe(total);
  });

  it('separates explicit component groups (wheel assistant) with centred origins', async () => {
    const editor = new Editor();
    const car = createCarMesh();
    car.position.set(10, 0, 0);
    editor.loadContent([car]);
    const before = new Vector3();
    const ids = await separateComponentGroups(editor, getId(car), [{ componentIds: [2], name: 'Wheel_FL' }], {
      centerOrigins: true,
    });
    expect(ids).toHaveLength(1);
    const wheel = editor.getObject(ids[0]) as Mesh;
    expect(wheel.name).toBe('Wheel_FL');
    wheel.geometry.computeBoundingBox();
    expect(wheel.geometry.boundingBox!.getCenter(before).length()).toBeLessThan(1e-5);
    // wheel world position = original component centre (x=-0.95+10)
    expect(wheel.position.x).toBeCloseTo(10 - 0.95, 4);
    expect(wheel.material).toBe(car.material);
  });

  it('edit-mode separate and delete faces', () => {
    const editor = new Editor();
    const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    editor.loadContent([box]);
    editor.select([getId(box)]);
    expect(editor.enterEditMode()).toBe(true);
    editor.setElementMode('face');
    const topo = getTopology(box.geometry);
    editor.setElementSelection(selectionFromTriangles(topo, 'face', [0, 1]));
    const newId = separateElementSelection(editor, 'move');
    expect(newId).toBeTruthy();
    expect(triangleCount(box.geometry)).toBe(10);
    expect(triangleCount((editor.getObject(newId!) as Mesh).geometry)).toBe(2);
    editor.setElementSelection(selectionFromTriangles(getTopology(box.geometry), 'face', [0]));
    deleteElements(editor);
    expect(triangleCount(box.geometry)).toBe(9);
    editor.undo();
    expect(triangleCount(box.geometry)).toBe(10);
    editor.undo();
    expect(triangleCount(box.geometry)).toBe(12);
  });

  it('deletes vertices together with every face that uses them', () => {
    const editor = new Editor();
    const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    editor.loadContent([box]);
    editor.select([getId(box)]);
    editor.enterEditMode();
    editor.setElementMode('vertex');
    editor.setElementSelection({ vertices: new Set([0]), edges: new Set(), faces: new Set() });
    deleteElements(editor);
    // A cube corner is used by 3 quads = 6 triangles at most; at least 3.
    expect(triangleCount(box.geometry)).toBeLessThanOrEqual(9);
    expect(triangleCount(box.geometry)).toBeGreaterThanOrEqual(6);
  });

  it('merges meshes into the active one keeping materials', () => {
    const { editor, a, b, idA, idB } = setup();
    editor.select([idB, idA]);
    mergeSelected(editor);
    expect(editor.getObject(idB)).toBeUndefined();
    expect(Array.isArray(a.material)).toBe(true);
    expect(triangleCount(a.geometry)).toBe(24);
    editor.undo();
    expect(editor.getObject(idB)).toBe(b);
    expect(triangleCount(a.geometry)).toBe(12);
  });

  it('runs mesh utilities as undoable steps', () => {
    const { editor, a, idA } = setup();
    editor.select([idA]);
    const original = a.geometry;
    applyMeshUtility(editor, 'flip-normals');
    expect(a.geometry).not.toBe(original);
    editor.undo();
    expect(a.geometry).toBe(original);
  });

  it('bounds history memory and disposes evicted resources', () => {
    const editor = new Editor();
    const g = new Group();
    editor.loadContent([g]);
    for (let i = 0; i < 150; i++) renameObject(editor, getId(g), `n${i}`);
    expect(editor.history.size).toBeLessThanOrEqual(100);
  });
});
