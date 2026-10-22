import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildIndex, routeCapture } from '../../src/shared/domain/captureRouter';
import type {
  CaptureFact,
  CaptureSection,
  RouterIndex,
  RouterIndexInput,
} from '../../src/shared/domain/captureRouter';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { ListDoc } from '../../src/shared/schema/lists';

const DIR = join(import.meta.dirname, '../../fixtures/capture');

interface Expected {
  route: string;
  section: CaptureSection | CaptureSection[];
  communityId?: string;
  startYear?: number;
  endYear?: number | null;
  demographic?: string;
  characters?: string[];
  categoryId?: string | null;
  categories?: string[];
  title?: string;
  glossary?: string;
  unknown?: string;
}
interface Examples {
  storyYear: number;
  lines: { line: number; text: string; facts: Expected[] }[];
}

function readSlice(): RouterIndexInput & { storyYear: number } {
  return JSON.parse(readFileSync(join(DIR, 'eastwinds-slice.json'), 'utf8')) as RouterIndexInput & {
    storyYear: number;
  };
}
const examples = JSON.parse(readFileSync(join(DIR, 'examples.json'), 'utf8')) as Examples;

/** What the router gave one fact, in the fixture's terms. */
function actual(f: CaptureFact, index: RouterIndex) {
  const main = f.drafts.find((d) => d.op === 'create' && d.collection === f.section)?.data ?? {};
  const name = (id: unknown) => index.characters.find((c) => c.id === id)?.name ?? String(id);
  return {
    route: f.route,
    section: f.section,
    communityId: (main.communityId as string | undefined) ?? f.communities[0]?.id,
    startYear: f.years.start,
    endYear: f.section === 'culturalEntries' ? (main.endYear as number) : f.years.end,
    demographic: main.demographic as string | undefined,
    characters: f.drafts
      .filter((d) => d.collection === 'moments')
      .map((d) => name(d.data?.characterId)),
    categoryId: (main.categoryId as string | undefined) ?? null,
    categories: f.candidates.filter((c) => c.kind === 'category').map((c) => c.label),
    title: main.title as string | undefined,
    glossary: f.drafts.find((d) => d.collection === 'glossaryTerms')?.data?.characters as
      string | undefined,
    unknown: f.candidates.find((c) => c.kind === 'unknown')?.label,
  };
}

describe('CR-10 the routing fixture', () => {
  test('CR-10 the East Winds slice holds documents in the shape of the schema', () => {
    const slice = readSlice();
    for (const l of slice.lists) expect(ListDoc.safeParse(l).success, l._id).toBe(true);
    for (const [collection, docs] of Object.entries(slice.entries)) {
      expect(isEntryCollection(collection), collection).toBe(true);
      if (!isEntryCollection(collection)) continue;
      for (const d of docs ?? []) {
        const r = entrySchemas[collection].safeParse(d);
        expect(r.success, `${collection} ${String(d._id)} ${r.error?.message ?? ''}`).toBe(true);
      }
    }
    expect(examples.lines).toHaveLength(12);
  });

  test('CR-10 CR-1 CR-5 the twelve lines of the design page route as expected', () => {
    const slice = readSlice();
    const index = buildIndex(slice);
    const mismatches: string[] = [];
    const rows: string[] = [];
    for (const line of examples.lines) {
      const routing = routeCapture(line.text, index, { storyYear: examples.storyYear });
      if (routing.facts.length !== line.facts.length) {
        mismatches.push(
          `line ${line.line}: ${routing.facts.length} facts, expected ${line.facts.length}`,
        );
      }
      for (const [i, want] of line.facts.entries()) {
        const f = routing.facts[i];
        if (!f) continue;
        const got = actual(f, index);
        rows.push(
          `${line.line}.${i} ${got.route} ${got.section} ${got.communityId ?? '-'} ${got.startYear}-${got.endYear ?? 'open'} ${got.demographic ?? '-'} ${got.characters.join('+') || '-'}`,
        );
        for (const key of Object.keys(want) as (keyof Expected)[]) {
          if (key === ('note' as string) || key === ('briefSaid' as string)) continue;
          const w = want[key];
          const g = got[key];
          const ok =
            key === 'section' && Array.isArray(w)
              ? w.includes(g as CaptureSection)
              : key === 'categories'
                ? JSON.stringify([...(g as string[])].sort()) ===
                  JSON.stringify([...(w as string[])].sort())
                : JSON.stringify(g) === JSON.stringify(w);
          if (!ok) {
            mismatches.push(
              `line ${line.line}.${i} ${key}: got ${JSON.stringify(g)}, expected ${JSON.stringify(w)}`,
            );
          }
        }
      }
    }
    console.log(`Capture router fixture\n${rows.join('\n')}`);
    if (mismatches.length) console.log(`Mismatches\n${mismatches.join('\n')}`);
    expect(mismatches).toEqual([]);
  });
});
