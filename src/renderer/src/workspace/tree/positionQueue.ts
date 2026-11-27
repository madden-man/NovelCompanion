/**
 * A57: when a tree read may set the base of the position writes. Each write
 * builds on the positions the write before it left; a `tree.get` answered
 * while writes were queued, or asked for before one was queued, can carry
 * positions from before a write landed, and taking it as the base would drop
 * that write's move from the next one. Such a read is set aside and read again.
 */
export interface PositionQueue {
  /** A write joins the queue. */
  enter(): void;
  /** A write left the queue; true when the queue is now idle and a read was set aside. */
  leave(): boolean;
  /** Taken when a read is asked for. */
  ticket(): Ticket;
  /** When the read answers: take it, set it aside until the queue is idle, or read again now. */
  fresh(t: Ticket): 'apply' | 'skip' | 'again';
}

export interface Ticket {
  gen: number;
  idle: boolean;
}

export function positionQueue(): PositionQueue {
  let depth = 0;
  let gen = 0;
  let missed = false;
  return {
    enter() {
      depth += 1;
      gen += 1;
    },
    leave() {
      depth = Math.max(0, depth - 1);
      if (depth > 0 || !missed) return false;
      missed = false;
      return true;
    },
    ticket: () => ({ gen, idle: depth === 0 }),
    fresh(t) {
      if (t.idle && depth === 0 && t.gen === gen) return 'apply';
      if (depth === 0) return 'again';
      missed = true;
      return 'skip';
    },
  };
}
