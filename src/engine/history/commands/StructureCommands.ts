import { Matrix4, type Object3D } from 'three';
import type { Command, CommandResources } from '../Command';
import { geometryBytes } from '../Command';
import { getId, hasGeometry, insertChild, objectMaterials, setLocalMatrix } from '../../scene/objectUtils';
import { type CommandHost, requireObject } from './types';

function subtreeResources(objects: Object3D[]): CommandResources {
  const geometries = new Set<CommandResources['geometries'][number]>();
  const materials = new Set<CommandResources['materials'][number]>();
  for (const root of objects) {
    root.traverse((o) => {
      if (hasGeometry(o)) geometries.add(o.geometry);
      for (const m of objectMaterials(o)) materials.add(m);
    });
  }
  return { geometries: [...geometries], materials: [...materials] };
}

function subtreeBytes(objects: Object3D[]): number {
  let bytes = 0;
  for (const g of subtreeResources(objects).geometries) bytes += geometryBytes(g);
  return bytes + objects.length * 512;
}

export interface AddEntry {
  object: Object3D;
  parentId: string;
  index?: number;
}

/** Inserts new objects (import, duplicate, separate...). Undo removes them again. */
export class AddObjectsCommand implements Command {
  readonly memoryCost: number;
  constructor(
    private readonly host: CommandHost,
    private readonly entries: AddEntry[],
    readonly label = 'Add objects',
  ) {
    this.memoryCost = subtreeBytes(entries.map((e) => e.object));
  }

  execute(): void {
    for (const e of this.entries) insertChild(requireObject(this.host, e.parentId), e.object, e.index);
    this.host.structureChanged();
    this.host.notify('scene', 'selection');
  }

  undo(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) this.entries[i].object.removeFromParent();
    this.host.structureChanged();
    this.host.notify('scene', 'selection');
  }

  resources(): CommandResources {
    return subtreeResources(this.entries.map((e) => e.object));
  }

  get objectIds(): string[] {
    return this.entries.map((e) => getId(e.object));
  }
}

interface RemovedEntry {
  object: Object3D;
  parent: Object3D;
  index: number;
}

/** Removes objects (and their subtrees). Undo re-inserts them at their original position. */
export class RemoveObjectsCommand implements Command {
  private removed: RemovedEntry[] = [];
  readonly memoryCost: number;
  constructor(
    private readonly host: CommandHost,
    private readonly ids: string[],
    readonly label = 'Delete',
  ) {
    this.memoryCost = subtreeBytes(ids.map((id) => requireObject(host, id)));
  }

  execute(): void {
    // Remove only top-most objects; descendants go with their ancestors.
    const objects = this.ids.map((id) => requireObject(this.host, id));
    const set = new Set(objects);
    const top = objects.filter((o) => {
      let p = o.parent;
      while (p) {
        if (set.has(p)) return false;
        p = p.parent;
      }
      return true;
    });
    this.removed = top.map((object) => ({
      object,
      parent: object.parent!,
      index: object.parent!.children.indexOf(object),
    }));
    for (const r of this.removed) r.object.removeFromParent();
    this.host.structureChanged();
    this.host.notify('scene', 'selection');
  }

  undo(): void {
    const sorted = [...this.removed].sort((a, b) => a.index - b.index);
    for (const r of sorted) insertChild(r.parent, r.object, r.index);
    this.host.structureChanged();
    this.host.notify('scene', 'selection');
  }

  resources(): CommandResources {
    return subtreeResources(this.removed.map((r) => r.object));
  }
}

interface ReparentState {
  id: string;
  parentId: string;
  index: number;
  matrix: Matrix4;
}

/** Moves objects under a new parent while preserving their world transforms. */
export class ReparentCommand implements Command {
  readonly memoryCost: number;
  private before: ReparentState[] = [];
  private after: ReparentState[] = [];
  constructor(
    private readonly host: CommandHost,
    ids: string[],
    newParentId: string,
    readonly label = 'Reparent',
    index?: number,
  ) {
    this.memoryCost = ids.length * 256;
    const newParent = requireObject(host, newParentId);
    newParent.updateWorldMatrix(true, false);
    const invParent = new Matrix4().copy(newParent.matrixWorld).invert();
    let insertAt = index;
    for (const id of ids) {
      const o = requireObject(host, id);
      o.updateWorldMatrix(true, false);
      o.updateMatrix();
      this.before.push({
        id,
        parentId: getId(o.parent!),
        index: o.parent!.children.indexOf(o),
        matrix: o.matrix.clone(),
      });
      const local = new Matrix4().multiplyMatrices(invParent, o.matrixWorld);
      this.after.push({ id, parentId: newParentId, index: insertAt ?? -1, matrix: local });
      if (insertAt !== undefined) insertAt++;
    }
  }

  private apply(states: ReparentState[], ascending: boolean): void {
    const ordered = ascending ? [...states].sort((a, b) => a.index - b.index) : states;
    for (const s of ordered) {
      const o = requireObject(this.host, s.id);
      const parent = requireObject(this.host, s.parentId);
      insertChild(parent, o, s.index >= 0 ? s.index : undefined);
      setLocalMatrix(o, s.matrix);
    }
    this.host.structureChanged();
    this.host.notify('scene', 'transform');
  }

  execute(): void {
    this.apply(this.after, false);
  }

  undo(): void {
    this.apply(this.before, true);
  }
}
