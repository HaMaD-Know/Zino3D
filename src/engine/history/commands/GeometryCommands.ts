import type { BufferGeometry, Material } from 'three';
import type { Command, CommandResources } from '../Command';
import { geometryBytes } from '../Command';
import { type CommandHost, requireObject } from './types';

export interface GeometryChange {
  id: string;
  before: BufferGeometry;
  after: BufferGeometry;
  beforeMaterial?: Material | Material[];
  afterMaterial?: Material | Material[];
}

/**
 * Swaps the geometry (and optionally the material) of mesh objects. Geometry is never mutated in place
 * by Zino3D operations, so the before/after objects can be swapped safely for undo/redo.
 */
export class ReplaceGeometryCommand implements Command {
  readonly memoryCost: number;
  constructor(
    private readonly host: CommandHost,
    private readonly changes: GeometryChange[],
    readonly label = 'Edit geometry',
  ) {
    this.memoryCost = changes.reduce((s, c) => s + geometryBytes(c.before) + geometryBytes(c.after), 0);
  }

  private apply(useAfter: boolean): void {
    for (const c of this.changes) {
      const o = requireObject(this.host, c.id) as unknown as {
        geometry: BufferGeometry;
        material: Material | Material[];
      };
      o.geometry = useAfter ? c.after : c.before;
      const material = useAfter ? c.afterMaterial : c.beforeMaterial;
      if (material) o.material = material;
    }
    this.host.notify('scene', 'edit', 'material');
  }

  execute(): void {
    this.apply(true);
  }

  undo(): void {
    this.apply(false);
  }

  resources(): CommandResources {
    const materials: Material[] = [];
    for (const c of this.changes) {
      for (const m of [c.beforeMaterial, c.afterMaterial]) {
        if (!m) continue;
        if (Array.isArray(m)) materials.push(...m);
        else materials.push(m);
      }
    }
    return { geometries: this.changes.flatMap((c) => [c.before, c.after]), materials };
  }
}
