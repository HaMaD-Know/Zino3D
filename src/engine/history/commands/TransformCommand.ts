import { Matrix4 } from 'three';
import type { Command } from '../Command';
import { setLocalMatrix } from '../../scene/objectUtils';
import { type CommandHost, requireObject } from './types';

export interface TransformEntry {
  id: string;
  before: Matrix4;
  after: Matrix4;
}

/** Changes local transforms of one or more objects. Stores only matrices, never geometry. */
export class TransformCommand implements Command {
  readonly memoryCost: number;
  constructor(
    private readonly host: CommandHost,
    private readonly entries: TransformEntry[],
    readonly label = 'Transform',
    /** When set, consecutive commands with the same key and ids are coalesced. */
    private readonly mergeKey?: string,
  ) {
    this.memoryCost = entries.length * 160;
  }

  execute(): void {
    for (const e of this.entries) setLocalMatrix(requireObject(this.host, e.id), e.after);
    this.host.notify('transform');
  }

  undo(): void {
    for (const e of this.entries) setLocalMatrix(requireObject(this.host, e.id), e.before);
    this.host.notify('transform');
  }

  mergeWith(next: Command): boolean {
    if (!this.mergeKey || !(next instanceof TransformCommand) || next.mergeKey !== this.mergeKey)
      return false;
    if (next.entries.length !== this.entries.length) return false;
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i].id !== next.entries[i].id) return false;
    for (let i = 0; i < this.entries.length; i++) this.entries[i].after = next.entries[i].after.clone();
    return true;
  }

  static capture(host: CommandHost, ids: string[]): Map<string, Matrix4> {
    const map = new Map<string, Matrix4>();
    for (const id of ids) {
      const o = requireObject(host, id);
      o.updateMatrix();
      map.set(id, o.matrix.clone());
    }
    return map;
  }
}
