import type { BibleHandle } from '../bibles';

export interface Migration {
  /** Versions start at 1 and increase by 1 with no gaps. */
  version: number;
  name: string;
  /** Runs against one bible. Use `bible.collection(name)`, which adds the bible's prefix. */
  up(bible: BibleHandle): Promise<void>;
}
