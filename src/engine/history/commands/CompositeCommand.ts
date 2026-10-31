import type { Command, CommandResources } from '../Command';

/** Runs several commands as one undo step (undone in reverse order). */
export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    private readonly commands: Command[],
  ) {}

  get memoryCost(): number {
    return this.commands.reduce((sum, c) => sum + (c.memoryCost ?? 0), 0);
  }

  execute(): void {
    for (const c of this.commands) c.execute();
  }

  undo(): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
  }

  resources(): CommandResources {
    const out: CommandResources = { geometries: [], materials: [] };
    for (const c of this.commands) {
      const r = c.resources?.();
      if (!r) continue;
      out.geometries.push(...r.geometries);
      out.materials.push(...r.materials);
    }
    return out;
  }
}
