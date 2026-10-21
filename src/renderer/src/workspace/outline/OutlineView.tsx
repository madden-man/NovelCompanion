import type { EntryCollection } from '../../../../shared/schema';
import { SceneOutline } from './Scenes';
import './outline.css';

type Open = (collection: EntryCollection, id: string) => void;

/**
 * The Outline screen (SM-7): the scene text with a year beside every scene,
 * and the chapter bars beside it, scrolling as one. The year grid (PL-2) is
 * withdrawn by SM-12.
 */
export function OutlineView({ onOpen }: { onOpen: Open }) {
  return <SceneOutline onOpen={onOpen} />;
}
