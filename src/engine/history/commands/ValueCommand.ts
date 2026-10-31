import type { Command } from '../Command';
import type { CommandHost, EditorChannel } from './types';

/** Generic reversible value change (rename, visibility, lock, material properties...). */
export class ValueCommand<T> implements Command {
  readonly memoryCost = 64;
  constructor(
    private readonly host: CommandHost,
    readonly label: string,
    private readonly apply: (value: T) => void,
    private readonly before: T,
    private after: T,
    private readonly channels: EditorChannel[],
    private readonly mergeKey?: string,
  ) {}

  execute(): void {
    this.apply(this.after);
    this.host.notify(...this.channels);
  }

  undo(): void {
    this.apply(this.before);
    this.host.notify(...this.channels);
  }

  mergeWith(next: Command): boolean {
    if (!this.mergeKey || !(next instanceof ValueCommand) || next.mergeKey !== this.mergeKey) return false;
    this.after = (next as ValueCommand<T>).after;
    return true;
  }
}
