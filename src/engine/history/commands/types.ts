import type { Object3D } from 'three';

export type EditorChannel =
  'scene' | 'selection' | 'transform' | 'history' | 'mode' | 'material' | 'settings' | 'edit' | 'status';

/** The subset of the Editor that commands depend on (keeps commands testable and avoids cycles). */
export interface CommandHost {
  readonly root: Object3D;
  getObject(id: string): Object3D | undefined;
  /** Must be called after structural changes. */
  structureChanged(): void;
  notify(...channels: EditorChannel[]): void;
}

export function requireObject(host: CommandHost, id: string): Object3D {
  const o = host.getObject(id);
  if (!o) throw new Error(`Object ${id} no longer exists.`);
  return o;
}
