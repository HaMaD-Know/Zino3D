import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PointLight,
  Vector3,
} from 'three';
import { Editor } from '../src/engine/editor/Editor';
import { AssetCache, deserializeScene, serializeScene } from '../src/engine/serialization/sceneSerializer';
import { SchemaError, migrateSceneDocument, validateSceneDocument } from '../src/engine/serialization/schema';
import {
  BACKUP_SPACING_MS,
  ProjectRepository,
  selectRetainedVersions,
  type ProjectVersion,
} from '../src/storage/projectRepository';
import { ProjectSession } from '../src/storage/autosave';
import { decodeBundle, encodeBundle } from '../src/storage/bundle';
import { renameObject, setLocked, setVisibility } from '../src/engine/editor/objectOperations';
import { createCarMesh } from '../src/engine/scene/sampleScenes';
import { assignIds, getId } from '../src/engine/scene/objectUtils';

let dbCounter = 0;
const repo = () => new ProjectRepository(`zino3d-test-${++dbCounter}`);

function sampleContent() {
  const car = createCarMesh();
  car.position.set(1, 2, 3);
  const group = new Group();
  group.name = 'Lights';
  const light = new PointLight(0xffaa00, 5, 10);
  light.name = 'Lamp';
  group.add(light);
  const glass = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshPhysicalMaterial({ transmission: 0.8, roughness: 0.1, color: 0x88ccff }),
  );
  glass.name = 'Glass';
  for (const o of [car, group, glass]) assignIds(o, 'missing');
  return [car, group, glass];
}

describe('scene serialization', () => {
  it('round-trips hierarchy, ids, transforms, groups, materials and lights', async () => {
    const content = sampleContent();
    const cache = new AssetCache();
    const result = await serializeScene(content, cache);
    expect(result.newAssets.size).toBeGreaterThan(0);
    const doc = validateSceneDocument(JSON.parse(JSON.stringify(result.document)));
    const back = await deserializeScene(doc, async (id) => result.newAssets.get(id));
    const [car, group, glass] = back.objects as [Mesh, Group, Mesh];
    expect(car.name).toBe('Car');
    expect(getId(car)).toBe(getId(content[0]));
    expect(car.position.toArray()).toEqual([1, 2, 3]);
    expect(car.geometry.groups).toEqual((content[0] as Mesh).geometry.groups);
    expect(Array.isArray(car.material) && car.material.map((m) => m.name)).toEqual([
      'Car Paint',
      'Tyre Rubber',
    ]);
    expect(car.geometry.getAttribute('position').array).toEqual(
      (content[0] as Mesh).geometry.getAttribute('position').array,
    );
    expect((group.children[0] as PointLight).isPointLight).toBe(true);
    expect((group.children[0] as PointLight).distance).toBe(10);
    expect((glass.material as MeshPhysicalMaterial).transmission).toBeCloseTo(0.8);
  });

  it('reuses unchanged binary assets on subsequent saves', async () => {
    const content = sampleContent();
    const cache = new AssetCache();
    const first = await serializeScene(content, cache);
    content[0].position.x = 99;
    const second = await serializeScene(content, cache);
    expect(second.newAssets.size).toBe(0);
    expect([...second.referencedAssets].sort()).toEqual([...first.referencedAssets].sort());
  });

  it('validates and migrates documents', () => {
    expect(() => validateSceneDocument({})).toThrow(SchemaError);
    expect(() =>
      validateSceneDocument({
        schemaVersion: 99,
        nodes: [],
        geometries: {},
        materials: {},
        textures: {},
        images: {},
      }),
    ).toThrow(/newer/);
    const migrated = migrateSceneDocument({ nodes: [], geometries: {}, materials: {} });
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.images).toEqual({});
  });
});

describe('project repository', () => {
  it('creates, saves, reloads, renames, duplicates and deletes', async () => {
    const r = repo();
    const p = await r.create('My Car');
    const content = sampleContent();
    const ser = await serializeScene(content, new AssetCache());
    await r.saveVersion(p.id, { ...ser, reason: 'manual' });
    const loaded = await r.loadDocument(p.id);
    expect(loaded!.document.nodes).toHaveLength(3);
    const objs = await deserializeScene(loaded!.document, (id) => r.readAsset(p.id, id));
    expect(objs.objects[0].name).toBe('Car');
    await r.rename(p.id, 'Renamed');
    expect((await r.get(p.id))!.name).toBe('Renamed');
    const copy = await r.duplicate(p.id);
    const copyDoc = await r.loadDocument(copy.id);
    expect(copyDoc!.document.nodes).toHaveLength(3);
    await r.delete(p.id);
    expect(await r.get(p.id)).toBeUndefined();
    // Copy still loads after the original was deleted (assets were copied, not shared).
    const copyObjs = await deserializeScene(copyDoc!.document, (id) => r.readAsset(copy.id, id));
    expect(copyObjs.objects).toHaveLength(3);
    expect((await r.list()).map((x) => x.id)).toEqual([copy.id]);
  });

  it('garbage-collects assets no longer referenced', async () => {
    const r = repo();
    const p = await r.create('GC');
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    const cache = new AssetCache();
    await r.saveVersion(p.id, { ...(await serializeScene([mesh], cache)), reason: 'manual' });
    const sizeA = await r.totalBytes(p.id);
    mesh.geometry = new BoxGeometry(2, 2, 2, 4, 4, 4);
    await r.saveVersion(p.id, { ...(await serializeScene([mesh], cache)), reason: 'manual' });
    mesh.geometry = new BoxGeometry(1, 1, 1);
    await r.saveVersion(p.id, { ...(await serializeScene([mesh], cache)), reason: 'manual' });
    const record = (await r.get(p.id))!;
    // latest + immediately previous are retained, the first is pruned (saves were < 5 minutes apart)
    expect(record.versions).toHaveLength(2);
    const total = await r.totalBytes(p.id);
    const expected = record.versions.reduce((s, v) => s + v.byteSize, 0);
    expect(total).toBeLessThanOrEqual(expected);
    expect(sizeA).toBeGreaterThan(0);
  });

  it('keeps spaced-out backups', () => {
    const v = (t: number): ProjectVersion => ({
      versionId: `v${t}`,
      savedAt: t,
      reason: 'autosave',
      assetIds: [],
      byteSize: 0,
    });
    const now = 10 * BACKUP_SPACING_MS;
    const versions = [
      v(now),
      v(now - 1000),
      v(now - 2000),
      v(now - BACKUP_SPACING_MS - 5000),
      v(now - 3 * BACKUP_SPACING_MS),
    ];
    const kept = selectRetainedVersions(versions).map((x) => x.versionId);
    expect(kept).toEqual([
      `v${now}`,
      `v${now - 1000}`,
      `v${now - BACKUP_SPACING_MS - 5000}`,
      `v${now - 3 * BACKUP_SPACING_MS}`,
    ]);
  });

  it('restores an older version', async () => {
    const r = repo();
    const p = await r.create('Restore');
    const cache = new AssetCache();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    mesh.name = 'first';
    await r.saveVersion(p.id, { ...(await serializeScene([mesh], cache)), reason: 'manual' });
    const firstVersion = (await r.get(p.id))!.versions[0].versionId;
    mesh.name = 'second';
    await r.saveVersion(p.id, { ...(await serializeScene([mesh], cache)), reason: 'manual' });
    await r.restoreVersion(p.id, firstVersion);
    const loaded = await r.loadDocument(p.id);
    expect(loaded!.document.nodes[0].name).toBe('first');
    expect(loaded!.version.reason).toBe('restore');
  });

  it('exports and imports a portable .zino3d bundle', async () => {
    const r = repo();
    const p = await r.create('Bundle me');
    await r.saveVersion(p.id, {
      ...(await serializeScene(sampleContent(), new AssetCache())),
      reason: 'manual',
    });
    const { blob } = await r.exportBundle(p.id);
    const decoded = decodeBundle(await blob.arrayBuffer());
    expect(decoded.manifest.project.name).toBe('Bundle me');
    const imported = await r.importBundle(await blob.arrayBuffer());
    expect(imported.name).toBe('Bundle me');
    const doc = await r.loadDocument(imported.id);
    const objs = await deserializeScene(doc!.document, (id) => r.readAsset(imported.id, id));
    expect(objs.objects[0].name).toBe('Car');
    expect(() => decodeBundle(new ArrayBuffer(16))).toThrow(/not a Zino3D project/);
    expect(
      encodeBundle({ name: 'x', createdAt: 0, updatedAt: 0 }, doc!.document, new Map()).size,
    ).toBeGreaterThan(0);
  });
});

describe('autosave and recovery', () => {
  it('autosaves after edits and a fresh session reloads the saved state', async () => {
    const r = repo();
    const p = await r.create('Autosave');
    const editor = new Editor();
    const session = new ProjectSession(editor, p.id, p.name, r, { debounceMs: 10 });
    await session.load();
    session.start();
    const content = sampleContent();
    editor.loadContent(content);
    const carId = getId(content[0]);
    renameObject(editor, carId, 'Saved Car');
    setVisibility(editor, [carId], false);
    setLocked(editor, [carId], true);
    expect(session.dirty).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    await session.flush();
    expect(session.dirty).toBe(false);
    expect(session.status.state).toBe('saved');
    await session.close();

    // Simulate an app restart: new editor + session reading from storage.
    const editor2 = new Editor();
    const session2 = new ProjectSession(editor2, p.id, p.name, r);
    await session2.load();
    const car = editor2.getObject(carId)!;
    expect(car.name).toBe('Saved Car');
    expect(car.visible).toBe(false);
    expect(editor2.isLocked(car)).toBe(true);
    expect(car.position.toArray()).toEqual(new Vector3(1, 2, 3).toArray());
    expect(editor2.history.canUndo).toBe(false);
  });
});
