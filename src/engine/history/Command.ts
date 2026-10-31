import type { BufferGeometry, Material } from 'three';

export interface CommandResources {
  geometries: BufferGeometry[];
  materials: Material[];
}

/**
 * A reversible editing operation. `execute` must be idempotent with respect to redo: it is called
 * once when first run (unless recorded as already applied) and again on every redo.
 */
export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
  /** Approximate bytes retained by this command (used to bound history memory). */
  readonly memoryCost?: number;
  /** Coalesce rapid successive edits (e.g. slider drags). Return true if `next` was absorbed. */
  mergeWith?(next: Command): boolean;
  /** GPU resources this command keeps alive, so they can be disposed when the entry is evicted. */
  resources?(): CommandResources;
}

export function geometryBytes(geometry: BufferGeometry | null | undefined): number {
  if (!geometry) return 0;
  let bytes = 0;
  for (const attr of Object.values(geometry.attributes)) bytes += attr.array.byteLength;
  for (const list of Object.values(geometry.morphAttributes))
    for (const attr of list) bytes += attr.array.byteLength;
  if (geometry.index) bytes += geometry.index.array.byteLength;
  return bytes;
}
