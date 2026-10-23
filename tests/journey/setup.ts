import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { exportBibleJson } from '../../src/main/backup/json';
import { connect, createBible } from '../../src/main/db';
import { briefCollections } from '../helpers/briefFixture';

const ROOT = join(import.meta.dirname, '../..');
const FIXTURE_FILES = join(ROOT, 'fixtures/files');

type Doc = { _id: string } & Record<string, unknown>;

export interface JourneyFiles {
  dir: string;
  /** The fixture novel (SPEC section 7 plus the M7 brief supplement) as an exported bible file. */
  bibleFile: string;
  wedding: string;
  letter: string;
  exportJson: string;
  recordings: string;
}

/**
 * Write the files the journey picks through the interface. The bible file is
 * made by the app's own export (BK-3) from the fixture loaded on a throwaway
 * local server, so the journey loads it exactly as a person loads a backup.
 */
export async function makeJourneyFiles(): Promise<JourneyFiles> {
  const dir = mkdtempSync(join(tmpdir(), 'nc-journey-'));
  const files: JourneyFiles = {
    dir,
    bibleFile: join(dir, 'tide-lines-fixture.json'),
    wedding: join(dir, 'chapter-03.docx'),
    letter: join(dir, 'Chapter 6 The Letter.docx'),
    exportJson: join(dir, 'tide-lines-export.json'),
    recordings: join(dir, 'recordings.json'),
  };
  copyFileSync(join(FIXTURE_FILES, 'chapter-03.docx'), files.wedding);
  await writeLetter(files.letter);

  // The recorded Claude: the suite's recordings plus the journey's own questions.
  const base = JSON.parse(readFileSync(join(ROOT, 'fixtures/claude/recordings.json'), 'utf8'));
  const extra = JSON.parse(readFileSync(join(import.meta.dirname, 'recordings.json'), 'utf8'));
  writeFileSync(files.recordings, JSON.stringify([...extra, ...base], null, 2));

  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    const store = await connect(server.getUri());
    try {
      const handle = await createBible(store, 'tide-lines', 'Tide Lines');
      for (const [collection, docs] of Object.entries(briefCollections(true))) {
        if (!docs.length) continue;
        if (collection === 'lists') {
          // The fixture's lists join the defaults every new bible has.
          for (const doc of docs) {
            await handle
              .collection<Doc>('lists')
              .replaceOne({ _id: doc._id }, doc, { upsert: true });
          }
        } else {
          await handle.collection<Doc>(collection).insertMany(docs as Doc[]);
        }
      }
      const { text } = await exportBibleJson(handle);
      writeFileSync(files.bibleFile, text);
    } finally {
      await store.close();
    }
  } finally {
    await server.stop();
  }
  return files;
}

/** Chapter 6 as a Word file, with an italic word and a scene break (MS-1). */
async function writeLetter(path: string): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'The Letter', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('Iris found the envelope under the '),
              new TextRun({ text: 'attic', italics: true }),
              new TextRun(' boards.'),
            ],
          }),
          new Paragraph({ text: '* * *' }),
          new Paragraph({ text: 'Daniel said nothing at dinner.' }),
        ],
      },
    ],
  });
  writeFileSync(path, await Packer.toBuffer(doc));
}
