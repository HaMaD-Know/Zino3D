import type { Command } from './Command';

export interface HistoryOptions {
  maxEntries: number;
  maxMemoryBytes: number;
  /** Time window in which consecutive mergeable commands are coalesced. */
  mergeWindowMs: number;
  onEvict?: (evicted: Command[]) => void;
  now?: () => number;
}

/** Bounded undo/redo stack. */
export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private lastPushTime = 0;
  private readonly options: HistoryOptions;

  constructor(options: Partial<HistoryOptions> = {}) {
    this.options = {
      maxEntries: options.maxEntries ?? 100,
      maxMemoryBytes: options.maxMemoryBytes ?? 256 * 1024 * 1024,
      mergeWindowMs: options.mergeWindowMs ?? 1000,
      onEvict: options.onEvict,
      now: options.now ?? (() => Date.now()),
    };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  memoryUsage(): number {
    let total = 0;
    for (const c of this.undoStack) total += c.memoryCost ?? 0;
    for (const c of this.redoStack) total += c.memoryCost ?? 0;
    return total;
  }

  /** Adds an already-applied command. */
  push(command: Command): void {
    const now = this.options.now!();
    const top = this.undoStack.at(-1);
    const discarded = this.redoStack;
    this.redoStack = [];
    if (discarded.length) this.options.onEvict?.(discarded);
    if (
      top &&
      top.mergeWith &&
      now - this.lastPushTime <= this.options.mergeWindowMs &&
      top.mergeWith(command)
    ) {
      this.lastPushTime = now;
      return;
    }
    this.undoStack.push(command);
    this.lastPushTime = now;
    this.enforceLimits();
  }

  undo(): Command | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.undo();
    this.redoStack.push(command);
    this.lastPushTime = 0;
    return command;
  }

  redo(): Command | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    command.execute();
    this.undoStack.push(command);
    this.lastPushTime = 0;
    return command;
  }

  /** All retained commands (undo + redo stacks). */
  retained(): Command[] {
    return [...this.undoStack, ...this.redoStack];
  }

  clear(): void {
    const all = this.retained();
    this.undoStack = [];
    this.redoStack = [];
    if (all.length) this.options.onEvict?.(all);
  }

  private enforceLimits(): void {
    const evicted: Command[] = [];
    while (this.undoStack.length > this.options.maxEntries) evicted.push(this.undoStack.shift()!);
    let memory = this.memoryUsage();
    // Always keep the most recent command even if it alone exceeds the budget.
    while (memory > this.options.maxMemoryBytes && this.undoStack.length > 1) {
      const c = this.undoStack.shift()!;
      memory -= c.memoryCost ?? 0;
      evicted.push(c);
    }
    if (evicted.length) this.options.onEvict?.(evicted);
  }
}
