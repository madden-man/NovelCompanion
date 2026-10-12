import {
  classifyFiles,
  bibleMarkdown,
  changeSummary,
  driveKind,
  exportFolderName,
  knownFrom,
} from '../../shared/domain/drive';
import type { DriveLink, DriveSeen } from '../../shared/domain/drive';
import type { EntryCollection } from '../../shared/schema';
import { ENTRY_COLLECTIONS } from '../../shared/schema';
import type { Channel } from '../../shared/ipc';
import type { driveContract } from '../../shared/ipcDrive';
import type { OpenBible } from '../db/session';
import { exportBibleJson } from '../backup/json';
import { REGISTRY } from '../db/bibles';
import { parseDocxBuffer } from '../import/docx';
import { parseWorkbookBuffer } from '../import/xlsx';
import type { DriveService } from '../drive/service';
import type { ImportBridge } from './importHandlers';
import type { Handler } from './validate';

export type DriveChannel = keyof typeof driveContract & Channel;
export type DriveHandlers = { [C in DriveChannel]: Handler<C> };

const NO_BIBLE = 'Open a bible first.';
const ORIGIN = /^drive:([A-Za-z0-9_-]+)@(.+)$/;

/** The origin an import from Drive carries, so applying it records the version (GD-3). */
export const driveOrigin = (fileId: string, modifiedTime: string) =>
  `drive:${fileId}@${modifiedTime}`;

export function driveHandlers(
  current: () => OpenBible | null,
  service: () => DriveService,
  bridge: () => ImportBridge | null,
): { handlers: DriveHandlers; onApplied: (origin: string) => Promise<void> } {
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };

  // Every change to the stored Drive state reads and writes it as one step, so two
  // overlapping requests (a check and a mark as reviewed) cannot overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const markSeen = (s: OpenBible, fileId: string, modifiedTime: string) =>
    exclusive(async () => {
      const state = s.repo.driveState();
      const seen: DriveSeen[] = [
        ...state.seen.filter((x) => x.fileId !== fileId),
        { fileId, modifiedTime, at: new Date().toISOString() },
      ];
      await s.repo.setDriveState({ links: state.links, seen });
    });

  const onApplied = async (origin: string) => {
    const m = ORIGIN.exec(origin);
    const s = current();
    if (!m || !s) return;
    await markSeen(s, m[1] as string, m[2] as string);
  };

  const handlers: DriveHandlers = {
    'drive.status': () => service().status(),
    'drive.setClient': ({ clientId, clientSecret }) => service().setClient(clientId, clientSecret),
    'drive.clearClient': () => service().clearClient(),
    'drive.connect': () => service().connect(),
    'drive.cancelConnect': () => ({ cancelled: service().cancelConnect() }),
    'drive.allowExport': () => service().allowExport(),
    'drive.disconnect': () => service().disconnect(),

    'drive.browse': ({ folderId, place, search }) => service().browse({ folderId, place, search }),

    'drive.links': () => ({ links: session().repo.driveState().links }),

    'drive.link': async ({ ids }) => {
      const s = session();
      const added: DriveLink[] = [];
      for (const id of ids) {
        if (s.repo.driveState().links.some((l) => l.id === id) || added.some((l) => l.id === id)) {
          continue;
        }
        const meta = await service().api.get(id);
        if (!meta || meta.trashed) throw new Error('That item is no longer in Google Drive.');
        const kind = driveKind(meta.mimeType, meta.name);
        if (kind === 'other') {
          throw new Error(
            `${meta.name} cannot be linked. The app links Word, Excel, Google Docs, and Google Sheets files, and folders.`,
          );
        }
        added.push({
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          kind,
          linkedAt: new Date().toISOString(),
        } satisfies DriveLink);
      }
      return exclusive(async () => {
        const state = s.repo.driveState();
        const links = [
          ...state.links,
          ...added.filter((a) => !state.links.some((l) => l.id === a.id)),
        ];
        await s.repo.setDriveState({ links, seen: state.seen });
        return { links };
      });
    },

    'drive.unlink': async ({ id }) => {
      const s = session();
      return exclusive(async () => {
        const state = s.repo.driveState();
        const links = state.links.filter((l) => l.id !== id);
        await s.repo.setDriveState({
          links,
          seen: state.seen,
          known: state.known.filter((k) => k.linkId !== id),
        });
        return { links };
      });
    },

    'drive.check': async () => {
      const s = session();
      const checkedAt = new Date().toISOString();
      const { links, seen, known } = s.repo.driveState();
      if (!service().status().connected) {
        return {
          checkedAt,
          connected: false,
          files: [],
          missingFolders: [],
          summary: links.length
            ? 'Google Drive is not connected, so linked files were not checked.'
            : '',
        };
      }
      const found = await service().check(links);
      const files = classifyFiles(
        links,
        found.remote,
        found.missing,
        seen,
        known,
        found.unreadable,
      );
      const missingFolders = found.missingFolders.map(
        (id) => links.find((l) => l.id === id)?.name ?? id,
      );
      // GD-3: remember what each folder holds, so a later check can say what vanished.
      //
      await exclusive(async () => {
        const now = s.repo.driveState();
        const fresh = knownFrom(found.remote);
        // Remembered files stay while their link does, so a file that vanished keeps showing as
        // gone on every check until the folder is unlinked or the file comes back.
        const keep = now.known.filter((k) => now.links.some((l) => l.id === k.linkId));
        const next = [...fresh, ...keep.filter((k) => !fresh.some((o) => o.fileId === k.fileId))];
        if (JSON.stringify(next) !== JSON.stringify(now.known)) {
          await s.repo.setDriveState({ links: now.links, seen: now.seen, known: next });
        }
      });
      const unreadable = found.unreadable.map((id) => links.find((l) => l.id === id)?.name ?? id);
      const summary = links.length ? changeSummary(files) : '';
      return {
        checkedAt,
        connected: true,
        files,
        missingFolders,
        summary: unreadable.length
          ? `${summary} Google Drive could not be read for ${unreadable.join(', ')}, so ${unreadable.length === 1 ? 'it was' : 'they were'} not fully checked. Check again later.`
          : summary,
      };
    },

    'drive.open': async ({ fileId }) => {
      session();
      const b = bridge();
      if (!b) throw new Error('Import is not available.');
      const f = await service().fetchFile(fileId);
      const source = { fileName: f.fileName, modifiedAt: f.modifiedAt };
      const origin = driveOrigin(f.fileId, f.modifiedAt);
      const file =
        f.kind === 'workbook'
          ? b.adopt(
              { kind: 'workbook', workbook: await parseWorkbookBuffer(f.data, source) },
              origin,
            )
          : b.adopt({ kind: 'document', document: await parseDocxBuffer(f.data, source) }, origin);
      return { file };
    },

    'drive.markSeen': async ({ fileId, modifiedTime }) => {
      const s = session();
      const known =
        s.repo.driveState().links.some((l) => l.id === fileId) ||
        (await service().api.get(fileId)) !== null;
      if (!known) throw new Error('That file is no longer in Google Drive.');
      await markSeen(s, fileId, new Date(modifiedTime).toISOString());
      return { ok: true as const };
    },

    'drive.exportFolders': async () => ({ folders: await service().exportFolders() }),

    'drive.createExportFolder': async ({ name }) => ({
      folder: await service().createExportFolder(name),
    }),

    'drive.export': async ({ folderId }) => {
      const s = session();
      // GD-4: only a folder this app created takes an export; say so plainly before Drive does not.
      if (!(await service().exportFolders()).some((f) => f.id === folderId)) {
        throw new Error(
          'That folder is not one this app created for exports. Choose an export folder from the list, or make a new one.',
        );
      }
      const at = new Date();
      // BK-3: the same JSON file the local export writes, lossless.
      const { text } = await exportBibleJson(s.handle, at);
      const collections: Partial<
        Record<EntryCollection, (Record<string, unknown> & { _id: string })[]>
      > = {};
      let entries = 0;
      for (const c of ENTRY_COLLECTIONS) {
        const live = s.model.all(c).filter((d) => !d.deletedAt);
        collections[c] = live as never;
        entries += live.length;
      }
      const name = await bibleName(s);
      const markdown = bibleMarkdown({
        bibleName: name,
        collections,
        lists: s.model.all('lists') as never,
      });
      const result = await service().exportBible({
        parentId: folderId,
        folderName: exportFolderName(name, at),
        json: { name: `${s.handle.id}.json`, text },
        markdown,
      });
      return { ...result, entries, sections: markdown.length };
    },
  };

  return { handlers, onApplied };
}

/** The bible's display name from the registry, for the export folder's name. */
async function bibleName(s: OpenBible): Promise<string> {
  const doc = await s.handle.db
    .collection<{ _id: string; name?: string }>(REGISTRY)
    .findOne({ _id: s.handle.id });
  return doc?.name ?? s.handle.id;
}

export const DRIVE_CHANNELS = Object.keys(
  driveHandlers(
    () => null,
    () => {
      throw new Error('unused');
    },
    () => null,
  ).handlers,
) as DriveChannel[];
