import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshPhongMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { createCarMesh } from '../src/engine/scene/sampleScenes';
import { computeConnectivity } from '../src/engine/geometry/connectivity';
import { readPositions, triangleVertexIndices } from '../src/engine/geometry/attributes';
import { collectComponentPoints, detectWheelCandidates } from '../src/engine/geometry/wheelDetection';
import { Editor } from '../src/engine/editor/Editor';
import {
  assignMaterialToSelection,
  convertToStandard,
  makeMaterialUnique,
  setMaterialValue,
  usersOf,
} from '../src/engine/editor/materialOperations';
import { getId } from '../src/engine/scene/objectUtils';
import { importModelFiles } from '../src/formats/importModel';
import { exportModel } from '../src/formats/exportModel';
import { fixture } from './helpers';

function candidatesFor(mesh: Mesh) {
  mesh.updateMatrixWorld(true);
  const positions = readPositions(mesh.geometry);
  const triangles = triangleVertexIndices(mesh.geometry);
  const conn = computeConnectivity({ positions, triangles }, { tolerance: 1e-6 });
  const points = collectComponentPoints(
    positions,
    triangles,
    conn.triangleComponent,
    conn.componentCount,
    mesh.matrixWorld.elements,
  );
  const comps = conn.components.map((c) => {
    const b = new Box3(new Vector3(...c.min), new Vector3(...c.max)).applyMatrix4(mesh.matrixWorld);
    return {
      id: c.id,
      min: b.min.toArray() as [number, number, number],
      max: b.max.toArray() as [number, number, number],
      points: points[c.id],
    };
  });
  const model = comps.reduce(
    (acc, c) => acc.union(new Box3(new Vector3(...c.min), new Vector3(...c.max))),
    new Box3(),
  );
  return {
    conn,
    result: detectWheelCandidates(comps, {
      min: model.min.toArray() as [number, number, number],
      max: model.max.toArray() as [number, number, number],
    }),
  };
}

describe('wheel candidate detection', () => {
  it('ranks the four wheels of a Y-up car first', () => {
    const { result } = candidatesFor(createCarMesh());
    expect(result.upAxis).toBe(1);
    const top4 = result.candidates
      .slice(0, 4)
      .map((c) => c.componentId)
      .sort();
    expect(top4).toEqual([2, 3, 4, 5]); // body=0, cabin=1, wheels follow
    expect(result.candidates[0].score).toBeGreaterThan(0.6);
    expect(result.candidates.every((c) => c.componentId > 1)).toBe(true);
  });

  it('does not assume orientation: works for a Z-up car rotated 90° about the vertical', () => {
    const car = createCarMesh();
    car.rotation.set(Math.PI / 2, 0, Math.PI / 2, 'ZYX'); // Y-up -> Z-up, then turned 90° about Z
    const { result } = candidatesFor(car);
    expect(result.upAxis).toBe(2);
    expect(
      result.candidates
        .slice(0, 4)
        .map((c) => c.componentId)
        .sort(),
    ).toEqual([2, 3, 4, 5]);
  });

  it('reports a single component when wheels are fused into the body', async () => {
    const r = await importModelFiles([fixture('car-fused-wheels.glb')]);
    let mesh: Mesh | null = null;
    r.root.traverse((o) => {
      if ((o as Mesh).isMesh) mesh = o as Mesh;
    });
    const { conn, result } = candidatesFor(mesh!);
    expect(conn.componentCount).toBe(2); // body+wheels fused, cabin separate
    expect(result.candidates.length).toBe(0);
  });
});

describe('material operations', () => {
  function scene() {
    const editor = new Editor();
    const shared = new MeshStandardMaterial({ color: 0xff0000 });
    shared.name = 'Shared';
    const a: Mesh = new Mesh(new BoxGeometry(), shared);
    const b: Mesh = new Mesh(new BoxGeometry(), shared);
    editor.loadContent([a, b]);
    return { editor, a, b, shared };
  }

  it('edits properties with undo and merges rapid slider changes', () => {
    const { editor, shared } = scene();
    setMaterialValue(editor, shared, 'roughness', 0.2);
    setMaterialValue(editor, shared, 'roughness', 0.3);
    expect(shared.roughness).toBe(0.3);
    editor.undo();
    expect(shared.roughness).toBe(1);
    setMaterialValue(editor, shared, 'color', 0x00ff00);
    expect(shared.color.getHex()).toBe(0x00ff00);
    editor.undo();
    expect(shared.color.getHex()).toBe(0xff0000);
  });

  it('lowering opacity enables blending so the change is visible', () => {
    const { editor, shared } = scene();
    setMaterialValue(editor, shared, 'opacity', 0.5);
    expect(shared.transparent).toBe(true);
  });

  it('makes a shared material unique for one object', () => {
    const { editor, a, b, shared } = scene();
    expect(usersOf(editor, shared)).toBe(2);
    const copy = makeMaterialUnique(editor, getId(a), 0)!;
    expect(a.material).toBe(copy);
    expect(b.material).toBe(shared);
    setMaterialValue(editor, copy, 'metalness', 1);
    expect(shared.metalness).toBe(0);
    editor.undo();
    editor.undo();
    expect(a.material).toBe(shared);
  });

  it('assigns materials and converts legacy materials to PBR', () => {
    const { editor, a, b } = scene();
    const phong = new MeshPhongMaterial({ color: 0x123456 });
    (a as Mesh).material = phong;
    convertToStandard(editor, getId(a), 0);
    expect((a.material as MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect((a.material as MeshStandardMaterial).color.getHex()).toBe(0x123456);
    editor.select([getId(b)]);
    assignMaterialToSelection(editor, a.material as MeshStandardMaterial);
    expect(b.material).toBe(a.material);
  });

  it('material edits survive a GLB round trip', async () => {
    const { editor, shared } = scene();
    setMaterialValue(editor, shared, 'metalness', 0.75);
    setMaterialValue(editor, shared, 'roughness', 0.25);
    setMaterialValue(editor, shared, 'color', 0x3366cc);
    setMaterialValue(editor, shared, 'emissive', 0x110000);
    setMaterialValue(editor, shared, 'side', 2);
    const out = await exportModel({
      format: 'glb',
      objects: editor.root.children,
      onlyVisible: true,
      fileName: 'mat',
    });
    const back = await importModelFiles([new File([await out.blob.arrayBuffer()], 'mat.glb')]);
    let m: MeshStandardMaterial | null = null;
    back.root.traverse((o) => {
      if ((o as Mesh).isMesh) m = (o as Mesh).material as MeshStandardMaterial;
    });
    expect(m!.metalness).toBeCloseTo(0.75);
    expect(m!.roughness).toBeCloseTo(0.25);
    expect(m!.color.getHex()).toBe(0x3366cc);
    expect(m!.emissive.getHex()).toBe(0x110000);
    expect(m!.side).toBe(2);
  });
});
