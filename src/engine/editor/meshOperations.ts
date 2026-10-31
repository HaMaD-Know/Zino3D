import { type BufferGeometry, type Material, Matrix4, Mesh, type Object3D, Vector3 } from 'three';
import type { Editor } from './Editor';
import type { Command } from '../history/Command';
import { CompositeCommand } from '../history/commands/CompositeCommand';
import {
  AddObjectsCommand,
  RemoveObjectsCommand,
  ReparentCommand,
} from '../history/commands/StructureCommands';
import { ReplaceGeometryCommand, type GeometryChange } from '../history/commands/GeometryCommands';
import { UD, assignIds, getId, isMesh } from '../scene/objectUtils';
import { countMask, extractTriangles, separateByComponents } from '../geometry/extract';
import {
  cleanupGeometry,
  flipNormals,
  mergeGeometries,
  recalculateNormals,
  translateGeometry,
  weldVertices,
} from '../geometry/operations';
import { defaultWeldTolerance, readPositions, triangleVertexIndices } from '../geometry/attributes';
import { computeConnectivityAsync } from '../geometry/workerClient';
import {
  emptyElementSelection,
  getTopology,
  selectionSize,
  selectionToTriangleMask,
} from '../geometry/topology';

function isSkinned(o: Object3D): boolean {
  return (o as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/** Meshes in the selected subtrees (or the edit target in Edit Mode) that can be edited. */
export function targetMeshes(editor: Editor): Mesh[] {
  if (editor.mode === 'edit') {
    const t = editor.editTarget();
    return t ? [t] : [];
  }
  const out = new Set<Mesh>();
  for (const o of editor.topLevelSelection()) {
    o.traverse((c) => {
      if (isMesh(c) && !editor.isLocked(c) && !isSkinned(c)) out.add(c);
    });
  }
  return [...out];
}

/** Creates a sibling mesh with the same transform/material as `source` and the given geometry. */
function makeSibling(
  editor: Editor,
  source: Mesh,
  geometry: BufferGeometry,
  name: string,
  taken: Set<string>,
): Mesh {
  const mesh = new Mesh(geometry, source.material);
  mesh.name = name;
  mesh.position.copy(source.position);
  mesh.quaternion.copy(source.quaternion);
  mesh.scale.copy(source.scale);
  mesh.castShadow = source.castShadow;
  mesh.receiveShadow = source.receiveShadow;
  mesh.userData = { ...structuredClone(source.userData) };
  delete mesh.userData[UD.id];
  delete mesh.userData[UD.locked];
  assignIds(mesh, 'fresh', taken);
  void editor;
  return mesh;
}

/** Moves a new part's origin to its geometry centre (useful for wheels so they rotate about their axle). */
function centerOrigin(mesh: Mesh): void {
  const g = mesh.geometry;
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3());
  if (c.lengthSq() === 0) return;
  const centered = translateGeometry(g, c);
  g.dispose();
  mesh.geometry = centered;
  mesh.updateMatrix();
  const shifted = mesh.matrix.clone().multiply(new Matrix4().makeTranslation(c.x, c.y, c.z));
  shifted.decompose(mesh.position, mesh.quaternion, mesh.scale);
}

export interface SeparateResult {
  createdIds: string[];
  componentCount: number;
}

/**
 * Separate by loose parts: every disconnected component becomes its own object. The largest component
 * stays in the original object. World-space appearance is preserved exactly.
 */
export async function separateLooseParts(
  editor: Editor,
  options: { centerOrigins?: boolean } = {},
): Promise<SeparateResult> {
  const meshes = targetMeshes(editor);
  if (meshes.length === 0) {
    editor.message('warning', 'Select a mesh to separate.');
    return { createdIds: [], componentCount: 0 };
  }
  editor.setBusy('Finding loose parts…');
  try {
    const commands: Command[] = [];
    const created: string[] = [];
    let totalComponents = 0;
    const taken = new Set(editor.allIds());
    for (const mesh of meshes) {
      const positions = readPositions(mesh.geometry);
      const triangles = triangleVertexIndices(mesh.geometry);
      const conn = await computeConnectivityAsync(positions, triangles, defaultWeldTolerance(positions));
      totalComponents += conn.componentCount;
      if (conn.componentCount < 2) continue;
      const parts = separateByComponents(mesh.geometry, conn.triangleComponent, conn.componentCount);
      let keep = 0;
      conn.components.forEach((c, i) => {
        if (c.triangleCount > conn.components[keep].triangleCount) keep = i;
      });
      const parent = mesh.parent ?? editor.root;
      const entries = [];
      let n = 1;
      for (let i = 0; i < parts.length; i++) {
        if (i === keep) continue;
        const part = makeSibling(editor, mesh, parts[i], `${mesh.name || 'Mesh'}.part${n++}`, taken);
        if (options.centerOrigins) centerOrigin(part);
        entries.push({
          object: part as Object3D,
          parentId: getId(parent),
          index: parent.children.indexOf(mesh) + entries.length + 1,
        });
        created.push(getId(part));
      }
      commands.push(
        new ReplaceGeometryCommand(
          editor,
          [{ id: getId(mesh), before: mesh.geometry, after: parts[keep] }],
          'Keep largest part',
        ),
      );
      commands.push(new AddObjectsCommand(editor, entries, 'Add parts'));
    }
    if (commands.length === 0) {
      editor.message('info', 'The selected mesh has no loose parts (it is a single connected piece).');
      return { createdIds: [], componentCount: totalComponents };
    }
    editor.execute(new CompositeCommand('Separate by loose parts', commands));
    editor.message('success', `Separated into ${created.length + meshes.length} objects.`);
    return { createdIds: created, componentCount: totalComponents };
  } finally {
    editor.setBusy(null);
  }
}

/**
 * Separates explicit groups of components of a mesh into new objects (wheel assistant).
 * Each entry in `groups` becomes one new object; remaining components stay in the original.
 */
export async function separateComponentGroups(
  editor: Editor,
  meshId: string,
  groups: Array<{ componentIds: number[]; name: string }>,
  options: { centerOrigins?: boolean } = {},
): Promise<string[]> {
  const mesh = editor.getObject(meshId);
  if (!isMesh(mesh) || editor.isLocked(mesh)) {
    editor.message('warning', 'The mesh is missing or locked.');
    return [];
  }
  const nonEmpty = groups.filter((g) => g.componentIds.length > 0);
  if (nonEmpty.length === 0) return [];
  const positions = readPositions(mesh.geometry);
  const triangles = triangleVertexIndices(mesh.geometry);
  const conn = await computeConnectivityAsync(positions, triangles, defaultWeldTolerance(positions));
  const taken = new Set(editor.allIds());
  const used = new Uint8Array(conn.triangleComponent.length);
  const parent = mesh.parent ?? editor.root;
  const entries = [];
  const created: string[] = [];
  for (const group of nonEmpty) {
    const set = new Set(group.componentIds);
    const mask = new Uint8Array(conn.triangleComponent.length);
    for (let t = 0; t < mask.length; t++) {
      if (set.has(conn.triangleComponent[t]) && !used[t]) {
        mask[t] = 1;
        used[t] = 1;
      }
    }
    if (countMask(mask) === 0) continue;
    const part = makeSibling(editor, mesh, extractTriangles(mesh.geometry, mask), group.name, taken);
    if (options.centerOrigins) centerOrigin(part);
    entries.push({
      object: part as Object3D,
      parentId: getId(parent),
      index: parent.children.indexOf(mesh) + entries.length + 1,
    });
    created.push(getId(part));
  }
  const remainingMask = new Uint8Array(used.length);
  for (let t = 0; t < used.length; t++) remainingMask[t] = used[t] ? 0 : 1;
  const commands: Command[] = [];
  if (countMask(remainingMask) > 0) {
    commands.push(
      new ReplaceGeometryCommand(
        editor,
        [{ id: meshId, before: mesh.geometry, after: extractTriangles(mesh.geometry, remainingMask) }],
        'Remove separated parts',
      ),
    );
    commands.push(new AddObjectsCommand(editor, entries, 'Add parts'));
  } else {
    // Everything was separated: replace the original object entirely.
    commands.push(new AddObjectsCommand(editor, entries, 'Add parts'));
    commands.push(new RemoveObjectsCommand(editor, [meshId], 'Remove empty object'));
  }
  editor.execute(new CompositeCommand(`Separate ${created.length} part(s)`, commands));
  editor.select(created);
  return created;
}

/** Edit Mode: separate (move) or duplicate (copy) the selected geometry into a new object. */
export function separateElementSelection(
  editor: Editor,
  mode: 'move' | 'copy',
  options: { name?: string; centerOrigin?: boolean } = {},
): string | null {
  const mesh = editor.editTarget();
  if (!mesh) return null;
  const topo = getTopology(mesh.geometry);
  const mask = selectionToTriangleMask(topo, editor.elementMode, editor.elementSelection, 'contained');
  const count = countMask(mask);
  if (count === 0) {
    editor.message('warning', 'Select faces (or all vertices/edges of at least one face) first.');
    return null;
  }
  const taken = new Set(editor.allIds());
  const part = makeSibling(
    editor,
    mesh,
    extractTriangles(mesh.geometry, mask),
    options.name ?? `${mesh.name || 'Mesh'}.${mode === 'move' ? 'separated' : 'duplicate'}`,
    taken,
  );
  if (options.centerOrigin) centerOrigin(part);
  const parent = mesh.parent ?? editor.root;
  const commands: Command[] = [];
  if (mode === 'move') {
    if (count === topo.triangleCount) {
      editor.message('warning', 'All faces are selected; nothing would remain. Use Duplicate instead.');
      part.geometry.dispose();
      return null;
    }
    const remaining = new Uint8Array(mask.length);
    for (let t = 0; t < mask.length; t++) remaining[t] = mask[t] ? 0 : 1;
    commands.push(
      new ReplaceGeometryCommand(
        editor,
        [{ id: getId(mesh), before: mesh.geometry, after: extractTriangles(mesh.geometry, remaining) }],
        'Remove selection',
      ),
    );
  }
  commands.push(
    new AddObjectsCommand(
      editor,
      [{ object: part, parentId: getId(parent), index: parent.children.indexOf(mesh) + 1 }],
      'Add part',
    ),
  );
  editor.execute(
    new CompositeCommand(
      mode === 'move' ? `Separate ${count} face(s)` : `Duplicate ${count} face(s)`,
      commands,
    ),
  );
  editor.setElementSelection(emptyElementSelection());
  editor.message(
    'success',
    `${mode === 'move' ? 'Separated' : 'Duplicated'} ${count} face(s) into "${part.name}".`,
  );
  return getId(part);
}

/** Edit Mode: delete selected vertices / edges (and every face using them) or faces. */
export function deleteElements(editor: Editor): void {
  const mesh = editor.editTarget();
  if (!mesh) return;
  const topo = getTopology(mesh.geometry);
  const sel = editor.elementSelection;
  if (selectionSize(editor.elementMode, sel) === 0) {
    editor.message('warning', 'Nothing is selected.');
    return;
  }
  const mask = selectionToTriangleMask(topo, editor.elementMode, sel, 'touching');
  const count = countMask(mask);
  if (count === 0) {
    editor.message('info', 'The selection does not use any faces.');
    return;
  }
  const keep = new Uint8Array(mask.length);
  for (let t = 0; t < mask.length; t++) keep[t] = mask[t] ? 0 : 1;
  if (count === topo.triangleCount) {
    editor.execute(new RemoveObjectsCommand(editor, [getId(mesh)], 'Delete all geometry'));
    editor.message('info', 'All faces were deleted, so the object was removed.');
    return;
  }
  editor.execute(
    new ReplaceGeometryCommand(
      editor,
      [{ id: getId(mesh), before: mesh.geometry, after: extractTriangles(mesh.geometry, keep) }],
      `Delete ${count} face(s)`,
    ),
  );
  editor.setElementSelection(emptyElementSelection());
  editor.message('success', `Deleted ${count} face(s). The mesh may now have open holes.`);
}

/** Merges selected meshes into the active mesh (joins geometry, keeps every material as a group). */
export function mergeSelected(editor: Editor): void {
  const active = editor.activeObject();
  const meshes = editor.selectedObjects().filter((o): o is Mesh => isMesh(o) && !editor.isLocked(o));
  if (!isMesh(active) || meshes.length < 2) {
    editor.message(
      'warning',
      'Select two or more meshes; the last selected (active) mesh receives the result.',
    );
    return;
  }
  if (meshes.some(isSkinned)) {
    editor.message('error', 'Skinned meshes cannot be merged.');
    return;
  }
  const others = meshes.filter((m) => m !== active);
  active.updateWorldMatrix(true, false);
  const inv = new Matrix4().copy(active.matrixWorld).invert();
  const sources = meshes.map((m) => {
    m.updateWorldMatrix(true, false);
    return {
      geometry: m.geometry,
      matrix: m === active ? new Matrix4() : new Matrix4().multiplyMatrices(inv, m.matrixWorld),
      materials: Array.isArray(m.material) ? m.material : [m.material],
    };
  });
  const result = mergeGeometries(sources);
  const material: Material | Material[] =
    result.materials.length === 1 ? result.materials[0] : result.materials;
  if (result.materials.length === 1) result.geometry.clearGroups();
  const commands: Command[] = [];
  const orphanChildren = others.flatMap((m) => m.children.map(getId));
  if (orphanChildren.length) {
    const c = new ReparentCommand(editor, orphanChildren, getId(active), 'Keep children');
    commands.push(c);
  }
  const change: GeometryChange = {
    id: getId(active),
    before: active.geometry,
    after: result.geometry,
    beforeMaterial: active.material,
    afterMaterial: material,
  };
  commands.push(new ReplaceGeometryCommand(editor, [change], 'Merge geometry'));
  commands.push(new RemoveObjectsCommand(editor, others.map(getId), 'Remove merged'));
  editor.execute(new CompositeCommand(`Merge ${meshes.length} meshes`, commands));
  editor.select([getId(active)]);
  for (const m of result.messages) editor.message('warning', m);
  editor.message('success', `Merged ${meshes.length} meshes into "${active.name || 'Mesh'}".`);
}

export type MeshCleanupKind = 'normals-smooth' | 'normals-flat' | 'flip-normals' | 'weld' | 'cleanup';

/** Applies a whole-mesh geometry utility to every target mesh as one undo step. */
export function applyMeshUtility(editor: Editor, kind: MeshCleanupKind, tolerance?: number): void {
  const meshes = targetMeshes(editor);
  if (meshes.length === 0) {
    editor.message('warning', 'Select a mesh first.');
    return;
  }
  const changes: GeometryChange[] = [];
  const messages: string[] = [];
  for (const mesh of meshes) {
    const g = mesh.geometry;
    let after: BufferGeometry;
    if (kind === 'normals-smooth') after = recalculateNormals(g, 'smooth');
    else if (kind === 'normals-flat') after = recalculateNormals(g, 'flat');
    else if (kind === 'flip-normals') after = flipNormals(g);
    else {
      const tol = tolerance ?? defaultWeldTolerance(readPositions(g));
      const r = kind === 'weld' ? weldVertices(g, tol) : cleanupGeometry(g, tol);
      after = r.geometry;
      messages.push(...r.messages.map((m) => (meshes.length > 1 ? `${mesh.name}: ${m}` : m)));
    }
    changes.push({ id: getId(mesh), before: g, after });
  }
  const labels: Record<MeshCleanupKind, string> = {
    'normals-smooth': 'Recalculate normals (smooth)',
    'normals-flat': 'Recalculate normals (flat)',
    'flip-normals': 'Flip normals',
    weld: 'Weld vertices',
    cleanup: 'Clean up mesh',
  };
  editor.execute(new ReplaceGeometryCommand(editor, changes, labels[kind]));
  if (editor.mode === 'edit') editor.setElementSelection(emptyElementSelection());
  editor.message('success', messages.length ? messages.join(' ') : `${labels[kind]}: done.`);
}

/** Edit Mode: moves selected vertices by a local-space offset (used by the edit-mode gizmo). */
export function translateElements(editor: Editor, offsetLocal: Vector3): void {
  const mesh = editor.editTarget();
  if (!mesh || offsetLocal.lengthSq() === 0) return;
  const topo = getTopology(mesh.geometry);
  const mask = selectionToTriangleMask(topo, editor.elementMode, editor.elementSelection, 'contained');
  const canon = new Set<number>();
  if (editor.elementMode === 'vertex') for (const v of editor.elementSelection.vertices) canon.add(v);
  else
    for (let t = 0; t < mask.length; t++)
      if (mask[t])
        for (let k = 0; k < 3; k++) canon.add(topo.connectivity.canonicalIds[topo.triangles[t * 3 + k]]);
  if (editor.elementMode === 'edge') {
    for (const key of editor.elementSelection.edges) for (const v of key.split('_')) canon.add(Number(v));
  }
  if (canon.size === 0) return;
  const after = mesh.geometry.clone();
  const pos = after.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    if (!canon.has(topo.connectivity.canonicalIds[v])) continue;
    pos.setXYZ(v, pos.getX(v) + offsetLocal.x, pos.getY(v) + offsetLocal.y, pos.getZ(v) + offsetLocal.z);
  }
  pos.needsUpdate = true;
  const normal = after.getAttribute('normal');
  if (normal) {
    // Update normals only around the moved vertices; authored normals elsewhere stay untouched.
    const temp = after.clone();
    temp.computeVertexNormals();
    const tn = temp.getAttribute('normal');
    const affected = new Set<number>();
    for (let t = 0; t < topo.triangleCount; t++) {
      const ids = topo.connectivity.canonicalIds;
      if (
        canon.has(ids[topo.triangles[t * 3]]) ||
        canon.has(ids[topo.triangles[t * 3 + 1]]) ||
        canon.has(ids[topo.triangles[t * 3 + 2]])
      ) {
        for (let k = 0; k < 3; k++) affected.add(topo.triangles[t * 3 + k]);
      }
    }
    for (const v of affected) normal.setXYZ(v, tn.getX(v), tn.getY(v), tn.getZ(v));
    normal.needsUpdate = true;
    temp.dispose();
  }
  after.computeBoundingBox();
  after.computeBoundingSphere();
  const sel = editor.elementSelection;
  editor.execute(
    new ReplaceGeometryCommand(
      editor,
      [{ id: getId(mesh), before: mesh.geometry, after }],
      `Move ${canon.size} vertex/vertices`,
    ),
  );
  // Same topology: keep the selection.
  editor.setElementSelection(sel);
}
