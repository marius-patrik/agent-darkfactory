export interface UndoManagerOptions {
  /**
   * Maximum number of undo steps to retain. Older steps are dropped once the
   * limit is exceeded. When omitted the stack is unbounded.
   */
  limit?: number;
}

/**
 * A generic undo/redo stack that stores snapshots of a serializable state.
 *
 * The manager keeps a base snapshot plus a stack of snapshots captured after
 * each state-changing action. `undo` rewinds to the previous snapshot and
 * `redo` advances to the next one.
 */
export class UndoManager<T> {
  private base?: T;
  private stack: T[] = [];
  private position = 0;
  private limit?: number;

  constructor(options?: UndoManagerOptions) {
    this.limit = options?.limit;
  }

  /**
   * Replace the base snapshot and clear the undo/redo history. This is useful
   * when a project is first loaded or after a save-point is established.
   */
  setBase(base: T): void {
    this.base = base;
    this.stack = [];
    this.position = 0;
  }

  /**
   * Push a new snapshot onto the stack, representing the state after the most
   * recent action. Any redo history after the current position is discarded.
   */
  push(state: T): void {
    if (this.position < this.stack.length) {
      this.stack.splice(this.position);
    }

    this.stack.push(state);
    this.position++;

    if (this.limit && this.stack.length > this.limit) {
      const overflow = this.stack.length - this.limit;
      this.stack.splice(0, overflow);
      this.position = Math.max(0, this.position - overflow);
    }
  }

  /** Return to the previous snapshot. */
  undo(): T | undefined {
    if (!this.canUndo) {
      return undefined;
    }

    this.position--;
    return this.current;
  }

  /** Advance to the next snapshot. */
  redo(): T | undefined {
    if (!this.canRedo) {
      return undefined;
    }

    const state = this.stack[this.position];
    this.position++;
    return state;
  }

  /** The snapshot that corresponds to the current position. */
  get current(): T | undefined {
    return this.position === 0 ? this.base : this.stack[this.position - 1];
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.stack.length;
  }

  /** Number of recorded actions (excluding the base snapshot). */
  get length(): number {
    return this.stack.length;
  }
}
