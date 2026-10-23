/**
 * Writes the fixture Word document into fixtures/files/.
 * Run with `npm run fixtures:files`. The outputs are committed; this script
 * exists so they can be rebuilt by hand, never during tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

const OUT = join(import.meta.dirname, '../fixtures/files');
async function wordDocument(): Promise<void> {
  const doc = new Document({
    creator: 'Novel Companion fixture',
    title: 'Chapter 3: Wedding Weather',
    sections: [
      {
        children: [
          new Paragraph({ text: 'Chapter 3: Wedding Weather', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('It rained on the wedding, and Peter said that was '),
              new TextRun({ text: 'lucky', italics: true }),
              new TextRun('. Meiling said nothing at all.'),
            ],
          }),
          new Paragraph({ text: '* * *' }),
          new Paragraph({ text: 'Daniel found her later on the porch, watching the river rise.' }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, 'chapter-03.docx'), buf);
}

mkdirSync(OUT, { recursive: true });
await wordDocument();
console.log(`Wrote fixture files to ${OUT}`);
