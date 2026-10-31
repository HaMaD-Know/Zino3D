import { describe, expect, it } from 'vitest';
import { type Mesh, type Object3D, Vector3 } from 'three';
import { importModelFiles } from '../src/formats/importModel';
import { exportModel } from '../src/formats/exportModel';
import { detectKind, validateGlb } from '../src/formats/detect';
import { Editor } from '../src/engine/editor/Editor';
import { renameObject, setTransform } from '../src/engine/editor/objectOperations';
import { separateLooseParts } from '../src/engine/editor/meshOperations';
import { getId, isMesh } from '../src/engine/scene/objectUtils';
import { triangleCount } from '../src/engine/geometry/attributes';
import { fixture } from './helpers';

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (isMesh(o)) out.push(o);
  });
  return out;
}

async function reimport(blob: Blob, name: string) {
  const file = new File([await blob.arrayBuffer()], name);
  return importModelFiles([file]);
}

describe('format detection and validation', () => {
  it('detects by magic bytes', () => {
    expect(detectKind('x.bin', new TextEncoder().encode('glTF'))).toBe('glb');
    expect(detectKind('model.obj', new Uint8Array(4))).toBe('obj');
    expect(detectKind('a.xyz', new Uint8Array(4))).toBe('unknown');
  });

  it('rejects malformed and unsupported files with readable errors', async () => {
    await expect(importModelFiles([fixture('malformed.glb')])).rejects.toThrow(/not a valid GLB/);
    await expect(importModelFiles([fixture('unsupported.xyz')])).rejects.toThrow(/Unsupported file type/);
    expect(validateGlb(new ArrayBuffer(8)).ok).toBe(false);
  });
});

describe('GLB import → edit → export → re-import', () => {
  it('imports hierarchy and stats', async () => {
    const r = await importModelFiles([fixture('multimesh.glb')]);
    expect(r.format).toBe('glb');
    expect(r.stats.meshes).toBe(3);
    expect(r.root.name).toBe('multimesh');
    expect(
      r.root
        .getObjectByName('Arm')!
        .children.map((c) => c.name)
        .sort(),
    ).toEqual(['Ball', 'Rod']);
  });

  it('multi-material meshes import as separate primitives', async () => {
    const r = await importModelFiles([fixture('multi-material.glb')]);
    expect(r.stats.materials).toBe(2);
    expect(r.stats.meshes).toBe(2);
  });

  it('round-trips names, hierarchy, transforms and geometry after edits', async () => {
    const editor = new Editor();
    const imported = await importModelFiles([fixture('multimesh.glb')]);
    editor.loadContent([imported.root]);
    const ball = editor.root.getObjectByName('Ball')!;
    renameObject(editor, getId(ball), 'Sphere Renamed');
    setTransform(editor, getId(ball), { position: [1, 2, 3] });
    ball.updateWorldMatrix(true, false);
    const ballWorld = new Vector3().setFromMatrixPosition(ball.matrixWorld);

    const exported = await exportModel({
      format: 'glb',
      objects: editor.root.children,
      onlyVisible: true,
      fileName: 'out',
    });
    expect(exported.fileName).toBe('out.glb');
    expect(exported.meshCount).toBe(3);
    const back = await reimport(exported.blob, 'out.glb');
    const renamed = back.root.getObjectByName('Sphere Renamed')!;
    expect(renamed).toBeTruthy();
    expect(renamed.parent!.name).toBe('Arm');
    renamed.updateWorldMatrix(true, false);
    expect(new Vector3().setFromMatrixPosition(renamed.matrixWorld).distanceTo(ballWorld)).toBeLessThan(1e-4);
    expect(back.stats.meshes).toBe(3);
    const origMesh = meshes(editor.root).find((m) => m.name === 'Sphere Renamed')!;
    expect(triangleCount((renamed as Mesh).geometry)).toBe(triangleCount(origMesh.geometry));
    expect(!!(renamed as Mesh).geometry.getAttribute('uv')).toBe(true);
    // Editor ids are stripped from deliverables.
    expect(renamed.userData.zinoId).toBeUndefined();
  });

  it('separates loose wheels and keeps them as separate objects through export', async () => {
    const editor = new Editor();
    const imported = await importModelFiles([fixture('car-loose-wheels.glb')]);
    editor.loadContent([imported.root]);
    const car = meshes(editor.root)[0];
    const totalTris = triangleCount(car.geometry);
    editor.select([getId(car)]);
    const r = await separateLooseParts(editor, { centerOrigins: true });
    expect(r.componentCount).toBe(6);
    const exported = await exportModel({
      format: 'glb',
      objects: editor.root.children,
      onlyVisible: true,
      fileName: 'car',
    });
    const back = await reimport(exported.blob, 'car.glb');
    const backMeshes = meshes(back.root);
    expect(backMeshes).toHaveLength(6);
    expect(backMeshes.reduce((s, m) => s + triangleCount(m.geometry), 0)).toBe(totalTris);
    for (const m of backMeshes) {
      expect(m.geometry.getAttribute('normal')).toBeTruthy();
      expect(m.geometry.getAttribute('uv')).toBeTruthy();
    }
  });

  it('exports only the selected objects with their world transform', async () => {
    const editor = new Editor();
    const imported = await importModelFiles([fixture('multimesh.glb')]);
    editor.loadContent([imported.root]);
    const rod = editor.root.getObjectByName('Rod')!;
    rod.updateWorldMatrix(true, false);
    const world = rod.matrixWorld.clone();
    const exported = await exportModel({ format: 'glb', objects: [rod], onlyVisible: true, fileName: 'rod' });
    const back = await reimport(exported.blob, 'rod.glb');
    expect(meshes(back.root)).toHaveLength(1);
    const m = meshes(back.root)[0];
    m.updateWorldMatrix(true, false);
    const e1 = m.matrixWorld.elements;
    world.elements.forEach((v, i) => expect(e1[i]).toBeCloseTo(v, 4));
  });

  it('exports OBJ and STL with honest warnings', async () => {
    const imported = await importModelFiles([fixture('cube.glb')]);
    const obj = await exportModel({
      format: 'obj',
      objects: [imported.root],
      onlyVisible: true,
      fileName: 'cube',
    });
    expect(await obj.blob.text()).toMatch(/^v /m);
    expect(obj.warnings.join(' ')).toMatch(/Materials/);
    const stl = await exportModel({
      format: 'stl',
      objects: [imported.root],
      onlyVisible: true,
      fileName: 'cube',
    });
    expect(stl.blob.size).toBe(84 + 12 * 50);
    const back = await reimport(stl.blob, 'cube.stl');
    expect(back.stats.triangles).toBe(12);
    const objBack = await reimport(obj.blob, 'cube.obj');
    expect(objBack.stats.triangles).toBe(12);
  });

  it('refuses to export an empty selection', async () => {
    const editor = new Editor();
    await expect(
      exportModel({ format: 'glb', objects: editor.root.children, onlyVisible: true, fileName: 'x' }),
    ).rejects.toThrow(/Nothing to export/);
  });
});
