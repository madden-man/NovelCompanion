import type { Channel, Request, Response } from './ipc';
import type { Op, UndoIO } from './domain/undoRunner';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/**
 * Undo and redo steps written through the IPC channels, like every other write.
 * A58 (PH-11): each entry write carries the `modifiedAt` the step's check read,
 * so an entry that changed somewhere else since is refused, never overwritten.
 */
export function undoIO(invoke: Invoke): UndoIO {
  const seen = new Map<string, string>();
  const key = (collection: string, id: string) => `${collection}/${id}`;
  const expect = (collection: string, id: string) => {
    const at = seen.get(key(collection, id));
    return at ? { expectModifiedAt: at } : {};
  };
  const saw = (collection: string, id: string, entry: { modifiedAt?: unknown } | undefined) => {
    if (typeof entry?.modifiedAt === 'string') seen.set(key(collection, id), entry.modifiedAt);
    else seen.delete(key(collection, id));
  };
  return {
    async get(collection, id) {
      try {
        const { entry } = await invoke('entry.get', { collection, id });
        saw(collection, id, entry);
        return entry;
      } catch {
        seen.delete(key(collection, id));
        return undefined;
      }
    },
    async listLabel(listId, itemId) {
      const { lists } = await invoke('lists.get', {});
      return lists.find((l) => l._id === listId)?.items.find((i) => i.id === itemId)?.label;
    },
    async apply(op: Op) {
      switch (op.kind) {
        case 'update': {
          const { collection, id, patch } = op;
          const r = await invoke('entry.update', {
            collection,
            id,
            patch,
            ...expect(collection, id),
          });
          saw(collection, id, r.entry);
          return;
        }
        case 'delete': {
          const { collection, id } = op;
          saw(
            collection,
            id,
            (await invoke('entry.delete', { collection, id, ...expect(collection, id) })).entry,
          );
          return;
        }
        case 'restore': {
          const { collection, id } = op;
          saw(
            collection,
            id,
            (await invoke('entry.restore', { collection, id, ...expect(collection, id) })).entry,
          );
          return;
        }
        case 'run':
          await op.apply();
          return;
        case 'rename':
          await invoke('lists.rename', { listId: op.listId, itemId: op.itemId, label: op.label });
      }
    },
  };
}
