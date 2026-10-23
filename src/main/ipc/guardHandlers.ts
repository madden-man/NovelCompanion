/**
 * Handlers for housekeeping (IP-16) and the manuscript lock (IP-18), branch
 * a47-guard. Independent of Electron, so the integration suite drives the
 * same code through the same zod contract (`src/shared/ipcGuard.ts`).
 */
import type { Channel, WireEntry } from '../../shared/ipc';
import { manuscriptChange } from '../../shared/domain/manuscript';
import type { OpenBible } from '../db/session';
import { parseLocator, wordSource } from '../session/sources';
import type { ManuscriptSource } from '../session/sources';
import type { SessionDeps } from './sessionHandlers';
import type { Handler } from './validate';

export type GuardChannel =
  'entry.purge' | 'trash.empty' | 'revisions.prune' | 'manuscript.reimport';

/** IP-18: Re-import on a chapter that was never imported from a file. */
export const NO_LINKED_MANUSCRIPT =
  'This chapter has no linked manuscript yet. Import it from a file first.';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function guardHandlers(
  current: () => OpenBible | null,
  deps: Pick<SessionDeps, 'sources' | 'pickFile'> = {},
): { [C in GuardChannel]: Handler<C & Channel> } {
  const session = () => {
    const s = current();
    if (!s) throw new Error('Open a bible first.');
    return s;
  };
  // The same sources as `manuscript.read` (MS-1): Word files.
  const sources = (): ManuscriptSource[] => {
    if (deps.sources) return deps.sources;
    return [wordSource(async () => (deps.pickFile ? deps.pickFile('document') : null))];
  };
  return {
    'entry.purge': ({ collection, id }) => session().repo.purge(collection, id),
    'trash.empty': () => session().repo.emptyTrash(),
    'revisions.prune': ({ collection, id, before, dryRun }) =>
      session().repo.pruneRevisions({ collection, id, before, dryRun }),
    'manuscript.reimport': async ({ chapterId }) => {
      const { model, repo } = session();
      const chapter = model.get('chapters', chapterId);
      if (!chapter || chapter.deletedAt) throw new Error('That chapter is not in the bible.');
      const linked = parseLocator(str(chapter.manuscriptSource));
      if (!linked) throw new Error(NO_LINKED_MANUSCRIPT);
      const source = sources().find((s) => s.id === linked.sourceId);
      if (!source) throw new Error('The source this chapter is linked to is not available.');
      const text = await source.read(linked.locator);
      const change = manuscriptChange(chapter, text.body);
      const read = {
        name: text.name,
        source: `${source.id}:${linked.locator}`,
        modifiedAt: text.modifiedAt,
        body: text.body,
        changed: change.changed,
        added: change.added,
        removed: change.removed,
        summaryOutOfDate: change.summaryOutOfDate,
        diff: change.diff,
      };
      const patch = {
        manuscriptText: text.body,
        sourceFile: text.name,
        manuscriptSource: read.source,
        summaryOutOfDate: change.summaryOutOfDate,
      };
      const stale = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (k) => (chapter[k] ?? (k === 'summaryOutOfDate' ? false : null)) !== patch[k],
      );
      if (!change.changed && !stale) {
        return { ...read, applied: false, entry: chapter as unknown as WireEntry, before: {} };
      }
      const before = Object.fromEntries(
        Object.keys(patch).map((k) => [k, chapter[k] ?? (k === 'summaryOutOfDate' ? false : null)]),
      );
      // The importer writes the locked manuscript fields (IP-18); nothing else may.
      const entry = await repo.update('chapters', chapterId, patch, { importer: true });
      return { ...read, applied: true, entry: entry as unknown as WireEntry, before };
    },
  };
}
