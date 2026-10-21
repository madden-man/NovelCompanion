import type { Channel, Request, Response } from './ipc';
import type { Op, UndoIO } from './domain/undoRunner';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/** Undo and redo steps written through the IPC channels, like every other write. */
export function undoIO(invoke: Invoke): UndoIO {
  return {
    async get(collection, id) {
      try {
        return (await invoke('entry.get', { collection, id })).entry;
      } catch {
        return undefined;
      }
    },
    async listLabel(listId, itemId) {
      const { lists } = await invoke('lists.get', {});
      return lists.find((l) => l._id === listId)?.items.find((i) => i.id === itemId)?.label;
    },
    async apply(op: Op) {
      switch (op.kind) {
        case 'update':
          await invoke('entry.update', { collection: op.collection, id: op.id, patch: op.patch });
          return;
        case 'delete':
          await invoke('entry.delete', { collection: op.collection, id: op.id });
          return;
        case 'restore':
          await invoke('entry.restore', { collection: op.collection, id: op.id });
          return;
        case 'run':
          await op.apply();
          return;
        case 'rename':
          await invoke('lists.rename', { listId: op.listId, itemId: op.itemId, label: op.label });
      }
    },
  };
}
