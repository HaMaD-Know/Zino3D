import { Box3, Euler, Group, Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import type { Editor } from './Editor';
import type { Command } from '../history/Command';
import { TransformCommand, type TransformEntry } from '../history/commands/TransformCommand';
import { ValueCommand } from '../history/commands/ValueCommand';
import {
  AddObjectsCommand,
  RemoveObjectsCommand,
  ReparentCommand,
} from '../history/commands/StructureCommands';
import { CompositeCommand } from '../history/commands/CompositeCommand';
import { ReplaceGeometryCommand, type GeometryChange } from '../history/commands/GeometryCommands';
import {
  ROOT_ID,
  UD,
  assignIds,
  getId,
  hasGeometry,
  isCollection,
  localBounds,
  worldBounds,
} from '../scene/objectUtils';
import { bakeMatrix, translateGeometry } from '../geometry/operations';
import { DEG2RAD } from '../../utils/math';

/** Returns the selected objects that may be edited, reporting locked ones. */
export function editableSelection(editor: Editor, action: string): Object3D[] {
  const objects = editor.topLevelSelection();
  const editable = objects.filter((o) => !editor.isLocked(o));
  if (objects.length === 0) editor.message('warning', `Select an object to ${action}.`);
  else if (editable.length < objects.length)
    editor.message('warning', `${objects.length - editable.length} locked object(s) were skipped.`);
  return editable;
}

export function renameObject(editor: Editor, id: string, name: string): void {
  const o = editor.getObject(id);
  if (!o) return;
  const trimmed = name.trim();
  if (trimmed === o.name || trimmed.length === 0) return;
  const before = o.name;
  editor.execute(
    new ValueCommand<string>(editor, `Rename to "${trimmed}"`, (v) => (o.name = v), before, trimmed, [
      'scene',
    ]),
  );
}

export function setVisibility(editor: Editor, ids: string[], visible: boolean): void {
  const objects = ids
    .map((id) => editor.getObject(id))
    .filter((o): o is Object3D => !!o && o.visible !== visible);
  if (objects.length === 0) return;
  const apply = (v: boolean[]) =>
    objects.forEach((o, i) => {
      o.visible = v[i];
      if (v[i]) delete o.userData[UD.hidden];
      else o.userData[UD.hidden] = true;
    });
  editor.execute(
    new ValueCommand<boolean[]>(
      editor,
      visible ? 'Show' : 'Hide',
      apply,
      objects.map((o) => o.visible),
      objects.map(() => visible),
      ['scene', 'selection'],
    ),
  );
}

export function showAll(editor: Editor): void {
  const hidden: string[] = [];
  editor.root.traverse((o) => {
    if (o !== editor.root && !o.visible) hidden.push(getId(o));
  });
  setVisibility(editor, hidden, true);
}

export function setLocked(editor: Editor, ids: string[], locked: boolean): void {
  const objects = ids.map((id) => editor.getObject(id)).filter((o): o is Object3D => !!o);
  if (objects.length === 0) return;
  const apply = (v: boolean[]) =>
    objects.forEach((o, i) => {
      if (v[i]) o.userData[UD.locked] = true;
      else delete o.userData[UD.locked];
    });
  editor.execute(
    new ValueCommand<boolean[]>(
      editor,
      locked ? 'Lock' : 'Unlock',
      apply,
      objects.map((o) => o.userData[UD.locked] === true),
      objects.map(() => locked),
      ['scene', 'selection'],
    ),
  );
}

export function deleteSelected(editor: Editor): void {
  const objects = editableSelection(editor, 'delete');
  if (objects.length === 0) return;
  editor.execute(new RemoveObjectsCommand(editor, objects.map(getId), `Delete ${objects.length} object(s)`));
}

/** Duplicates objects. Geometry and materials are shared until an edit replaces them. */
export function duplicateSelected(editor: Editor): string[] {
  const objects = editableSelection(editor, 'duplicate');
  if (objects.length === 0) return [];
  const taken = new Set(editor.allIds());
  const entries = objects.map((o) => {
    const copy = o.clone(true);
    assignIds(copy, 'fresh', taken);
    copy.name = `${o.name || 'Object'}.copy`;
    const parent = o.parent ?? editor.root;
    return { object: copy, parentId: getId(parent), index: parent.children.indexOf(o) + 1 };
  });
  const cmd = new AddObjectsCommand(editor, entries, `Duplicate ${objects.length} object(s)`);
  editor.execute(cmd);
  editor.select(cmd.objectIds);
  return cmd.objectIds;
}

export function reparent(editor: Editor, ids: string[], parentId: string, index?: number): void {
  const parent = editor.getObject(parentId);
  if (!parent) return;
  const objects = ids.map((id) => editor.getObject(id)).filter((o): o is Object3D => !!o);
  const valid = objects.filter((o) => {
    if (o === parent) return false;
    let p: Object3D | null = parent;
    while (p) {
      if (p === o) return false; // cannot parent into own descendant
      p = p.parent;
    }
    return !editor.isLocked(o);
  });
  if (valid.length === 0) {
    editor.message('warning', 'Those objects cannot be moved there.');
    return;
  }
  editor.execute(
    new ReparentCommand(editor, valid.map(getId), parentId, `Move to "${parent.name || 'Scene'}"`, index),
  );
}

/** Groups the selection under a new group placed at the selection's bounding-box centre. */
export function groupSelected(editor: Editor, name = 'Group'): string | null {
  const objects = editableSelection(editor, 'group');
  if (objects.length === 0) return null;
  const parent = objects[0].parent ?? editor.root;
  const group = new Group();
  group.name = name;
  assignIds(group, 'fresh', new Set(editor.allIds()));
  const center = worldBounds(objects).getCenter(new Vector3());
  parent.updateWorldMatrix(true, false);
  group.position.copy(parent.worldToLocal(center.clone()));
  const index = parent.children.indexOf(objects[0]);
  const add = new AddObjectsCommand(editor, [{ object: group, parentId: getId(parent), index }], 'Add group');
  add.execute();
  const move = new ReparentCommand(editor, objects.map(getId), getId(group), 'Group');
  move.execute();
  editor.record(new CompositeCommand(`Group ${objects.length} object(s)`, [add, move]));
  editor.select([getId(group)]);
  return getId(group);
}

/** Moves the children of selected groups to the groups' parents and removes the empty groups. */
export function ungroupSelected(editor: Editor): void {
  const groups = editableSelection(editor, 'ungroup').filter((o) => o.children.length > 0 && !hasGeometry(o));
  if (groups.length === 0) {
    editor.message('warning', 'Select a group (an object with children and no geometry) to ungroup.');
    return;
  }
  const commands: Command[] = [];
  const freed: string[] = [];
  for (const g of groups) {
    const parent = g.parent ?? editor.root;
    const children = [...g.children].map(getId);
    const move = new ReparentCommand(editor, children, getId(parent), 'Ungroup', parent.children.indexOf(g));
    move.execute();
    const remove = new RemoveObjectsCommand(editor, [getId(g)], 'Remove group');
    remove.execute();
    commands.push(move, remove);
    freed.push(...children);
  }
  editor.record(new CompositeCommand('Ungroup', commands));
  editor.select(freed);
}

export function createCollection(editor: Editor, name = 'Collection'): string {
  const group = new Group();
  group.name = name;
  group.userData[UD.collection] = true;
  assignIds(group, 'fresh', new Set(editor.allIds()));
  const cmd = new AddObjectsCommand(
    editor,
    [{ object: group, parentId: ROOT_ID }],
    `Create collection "${name}"`,
  );
  editor.execute(cmd);
  return getId(group);
}

export function collections(editor: Editor): Object3D[] {
  const out: Object3D[] = [];
  editor.root.traverse((o) => {
    if (isCollection(o)) out.push(o);
  });
  return out;
}

export interface NumericTransform {
  position?: [number, number, number];
  /** degrees, XYZ order */
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/** Sets local transform components numerically (inspector fields). Coalesces rapid edits. */
export function setTransform(editor: Editor, id: string, values: NumericTransform, mergeKey?: string): void {
  const o = editor.getObject(id);
  if (!o || editor.isLocked(o)) return;
  o.updateMatrix();
  const before = o.matrix.clone();
  const position = o.position.clone();
  const quaternion = o.quaternion.clone();
  const scale = o.scale.clone();
  if (values.position) position.fromArray(values.position);
  if (values.rotation) {
    const e = new Euler(
      values.rotation[0] * DEG2RAD,
      values.rotation[1] * DEG2RAD,
      values.rotation[2] * DEG2RAD,
      o.rotation.order,
    );
    quaternion.setFromEuler(e);
  }
  if (values.scale) {
    // Avoid exactly-zero scale, which makes the matrix non-invertible.
    scale.fromArray(values.scale.map((v) => (Math.abs(v) < 1e-6 ? (v < 0 ? -1e-6 : 1e-6) : v)));
  }
  const after = new Matrix4().compose(position, quaternion, scale);
  if (after.equals(before)) return;
  editor.execute(
    new TransformCommand(
      editor,
      [{ id, before, after }],
      'Set transform',
      mergeKey ? `${mergeKey}:${id}` : undefined,
    ),
  );
}

export function resetTransform(
  editor: Editor,
  parts: { position?: boolean; rotation?: boolean; scale?: boolean } = {
    position: true,
    rotation: true,
    scale: true,
  },
): void {
  const objects = editableSelection(editor, 'reset');
  const entries: TransformEntry[] = [];
  for (const o of objects) {
    o.updateMatrix();
    const p = parts.position ? new Vector3() : o.position.clone();
    const q = parts.rotation ? new Quaternion() : o.quaternion.clone();
    const s = parts.scale ? new Vector3(1, 1, 1) : o.scale.clone();
    entries.push({ id: getId(o), before: o.matrix.clone(), after: new Matrix4().compose(p, q, s) });
  }
  if (entries.length) editor.execute(new TransformCommand(editor, entries, 'Reset transform'));
}

export type OriginMode = 'geometry-center' | 'geometry-bottom' | 'world-origin' | 'cursor';

/**
 * Moves an object's origin (pivot) without changing how anything looks: the object's transform moves
 * by +p while its geometry and children move by -p (p expressed in the object's local space).
 */
export function setOrigin(editor: Editor, mode: OriginMode): void {
  const objects = editableSelection(editor, 'set origin');
  const commands: Command[] = [];
  for (const o of objects) {
    o.updateWorldMatrix(true, true);
    let p: Vector3;
    if (mode === 'geometry-center' || mode === 'geometry-bottom') {
      const box: Box3 = localBounds(o);
      if (box.isEmpty()) continue;
      p = box.getCenter(new Vector3());
      if (mode === 'geometry-bottom') p.y = box.min.y;
    } else {
      const world = mode === 'cursor' ? editor.cursor.clone() : new Vector3();
      p = o.worldToLocal(world);
    }
    if (p.lengthSq() < 1e-20) continue;
    const cmds: Command[] = [];
    o.updateMatrix();
    const shift = new Matrix4().makeTranslation(p.x, p.y, p.z);
    const unshift = new Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const entries: TransformEntry[] = [
      { id: getId(o), before: o.matrix.clone(), after: o.matrix.clone().multiply(shift) },
    ];
    for (const child of o.children) {
      child.updateMatrix();
      entries.push({
        id: getId(child),
        before: child.matrix.clone(),
        after: unshift.clone().multiply(child.matrix),
      });
    }
    if (hasGeometry(o)) {
      const change: GeometryChange = {
        id: getId(o),
        before: o.geometry,
        after: translateGeometry(o.geometry, p),
      };
      cmds.push(new ReplaceGeometryCommand(editor, [change], 'Move geometry'));
    }
    cmds.push(new TransformCommand(editor, entries, 'Move origin'));
    commands.push(...cmds);
  }
  if (commands.length === 0) {
    editor.message('info', 'Origin already at the requested position.');
    return;
  }
  editor.execute(new CompositeCommand('Set origin', commands));
}

export type ApplyMode = 'all' | 'rotation-scale' | 'scale';

/**
 * Bakes part of the object's local transform into its geometry (and children), resetting that part.
 * The world-space result is unchanged.
 */
export function applyTransform(editor: Editor, mode: ApplyMode): void {
  const objects = editableSelection(editor, 'apply transform');
  const commands: Command[] = [];
  for (const o of objects) {
    o.updateMatrix();
    const t = new Matrix4().makeTranslation(o.position.x, o.position.y, o.position.z);
    const r = new Matrix4().makeRotationFromQuaternion(o.quaternion);
    const s = new Matrix4().makeScale(o.scale.x, o.scale.y, o.scale.z);
    const applied =
      mode === 'all' ? o.matrix.clone() : mode === 'rotation-scale' ? r.clone().multiply(s) : s.clone();
    const remaining =
      mode === 'all' ? new Matrix4() : mode === 'rotation-scale' ? t.clone() : t.clone().multiply(r);
    if (applied.equals(new Matrix4())) continue;
    const entries: TransformEntry[] = [{ id: getId(o), before: o.matrix.clone(), after: remaining }];
    for (const child of o.children) {
      child.updateMatrix();
      entries.push({
        id: getId(child),
        before: child.matrix.clone(),
        after: applied.clone().multiply(child.matrix),
      });
    }
    if (hasGeometry(o)) {
      commands.push(
        new ReplaceGeometryCommand(
          editor,
          [{ id: getId(o), before: o.geometry, after: bakeMatrix(o.geometry, applied) }],
          'Bake transform',
        ),
      );
    }
    commands.push(new TransformCommand(editor, entries, 'Apply transform'));
  }
  if (commands.length === 0) {
    editor.message('info', 'Nothing to apply.');
    return;
  }
  editor.execute(new CompositeCommand('Apply transform', commands));
}

export function cursorToSelection(editor: Editor): void {
  const objects = editor.selectedObjects();
  if (objects.length === 0) return;
  const box = worldBounds(objects);
  if (box.isEmpty()) return;
  editor.setCursor(box.getCenter(new Vector3()));
}
