/**
 * The renderer's undo and redo stacks (ED-3, ARCHITECTURE rule 5). A command
 * holds the write that applies it and the inverse write that takes it back;
 * both replay through the normal write path. Pure, so unit tests cover it.
 */

export const UNDO_LIMIT = 100;

export interface Command<Op> {
  /** Plain words for the history list, for example "Changed Death on Margaret Hale". */
  label: string;
  /** Writes that undo the command, in order. */
  undo: Op[];
  /** Writes that redo the command, in order. */
  redo: Op[];
}

export class UndoStack<Op> {
  private done: Command<Op>[] = [];
  private undone: Command<Op>[] = [];

  constructor(readonly limit: number = UNDO_LIMIT) {
    if (limit < 50) throw new Error('ED-3 needs at least 50 steps of undo.');
  }

  /** Record a new command. It clears the redo stack and drops the oldest beyond the limit. */
  push(cmd: Command<Op>): void {
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.splice(0, this.done.length - this.limit);
    this.undone = [];
  }

  /** Take the newest command off the undo stack and move it to redo. */
  undo(): Command<Op> | undefined {
    const cmd = this.done.pop();
    if (cmd) this.undone.push(cmd);
    return cmd;
  }

  redo(): Command<Op> | undefined {
    const cmd = this.undone.pop();
    if (cmd) this.done.push(cmd);
    return cmd;
  }

  /** Put a command back where it was after its writes failed. */
  revertUndo(): void {
    const cmd = this.undone.pop();
    if (cmd) this.done.push(cmd);
  }

  revertRedo(): void {
    const cmd = this.done.pop();
    if (cmd) this.undone.push(cmd);
  }

  /** Drop the command an undo just moved to the redo stack, after it was skipped. */
  discardUndone(): void {
    this.undone.pop();
  }

  /** Drop the command a redo just moved back to the undo stack, after it was skipped. */
  discardDone(): void {
    this.done.pop();
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Newest first, for the history list. */
  history(): { undo: Command<Op>[]; redo: Command<Op>[] } {
    return { undo: [...this.done].reverse(), redo: [...this.undone].reverse() };
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
