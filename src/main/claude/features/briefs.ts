import { z } from 'zod';
import { GROUP_TITLES } from '../../../shared/domain/brief/selection';
import type { GroupKind, Selection } from '../../../shared/domain/brief/selection';
import { LEAD_SECTIONS } from '../../../shared/domain/brief/render';
import type { BriefMaterial } from '../../../shared/domain/brief/render';
import type { EntryRefWire } from '../../../shared/claude';
import { material } from '../prompts';
import type { FeatureDefinition } from '../runtime';

/**
 * Session briefs (SB-4, SB-5, DB-2). Claude is given the SB-2 selection's
 * contents and nothing else (no tools), and returns the brief as structured
 * items, each citing manifest IDs. Code, not Claude, lays the brief out: the
 * three DB-2 lead sections first and always present, canon apart from planned
 * material (SB-5), anything after the story year under "Planned ahead", and
 * what SB-6 left out. Citations are then checked against the manifest by
 * `citationProblems` and `uncitedLines` (src/shared/domain/brief/render.ts).
 */

const Material = z.strictObject({
  id: z.string().min(1).max(64),
  collection: z.string().max(64),
  group: z.string().max(64),
  strand: z.string().max(200).nullable(),
  title: z.string(),
  status: z.string().max(32),
  note: z.string(),
  detail: z.string(),
  refs: z.array(z.string().max(64)),
});

export const BriefsInput = z.strictObject({
  label: z.string().max(300),
  year: z.int(),
  /** Strand labels, primary first (A5). */
  strands: z.array(z.string().max(200)),
  /** The manifest (SB-3). */
  manifest: z.array(z.string().max(64)),
  material: z.array(Material),
});
export type BriefsInput = z.infer<typeof BriefsInput>;

/** One manifest ID, nothing else: "H5, H3" is not an ID (SB-4). */
const CITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Item = z.strictObject({
  /** One plain statement of fact from the material. Never prose for the novel. */
  text: z.string(),
  status: z.enum(['canon', 'planned']),
  /** The strand label it belongs to, or null when it is not strand-specific. */
  strand: z.string().nullable(),
  /** Manifest IDs the statement comes from. */
  cites: z.array(z.string().regex(CITE_ID)),
});
export type BriefItem = z.infer<typeof Item>;

export const BriefsOutput = z.strictObject({
  characters: z.array(Item),
  worldEvents: z.array(Item),
  culture: z.array(Item),
  sections: z.array(z.strictObject({ heading: z.string(), items: z.array(Item) })),
  plannedAhead: z.array(Item),
});
export type BriefsOutput = z.infer<typeof BriefsOutput>;

const INSTRUCTIONS = `You write the session brief a novelist reads before a writing session. The brief is a reference sheet of facts from the story bible, never prose for the novel.
Use only the selected entries inside the material tags. Do not add facts, guesses, or invented detail. Ages and alive-or-dead states are computed by the app: report them as given.
Return structured items. Each item is one short plain statement and cites, in "cites", the ID of every entry it comes from (the ID in square brackets at the start of each entry). An item with no citation will be flagged.
Fill these three lead sections first, every time, even if one is nearly empty: "characters" (each character present and their age at the story year), "worldEvents" (the era and the world events ongoing at that time, including formative ones), and "culture" (the cultural expectations bearing on those characters at that moment).
Then add "sections" for the rest of the material, in this order where there is material for it: places, backstory (the moments of each character's life up to the story year), previous chapters, glossary and open questions (decided questions with their decision, apart from open ones), the last session note. Give each a short plain heading.
Mark each item "canon" only when every entry it cites is canon; otherwise "planned".
Nothing that happens after the story year goes anywhere except "plannedAhead".
When the section has more than one strand, set "strand" to the strand's label for strand material; otherwise null.`;

function entryLine(m: BriefMaterial | z.infer<typeof Material>): string {
  const head = `[${m.id}] ${m.title} (${GROUP_TITLES[m.group as GroupKind] ?? m.group}; ${m.status}${
    m.strand ? `; strand: ${m.strand}` : ''
  })`;
  const parts = [m.note, m.detail].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const refs = m.refs.length ? ` Draws on: ${m.refs.map((r) => `[${r}]`).join(' ')}.` : '';
  return `${head}: ${parts.join('. ')}.${refs}`;
}

/** The input a brief run is given, built from the selection only (SB-4). */
export function briefsInput(sel: Selection, mats: BriefMaterial[]): BriefsInput {
  return {
    label: sel.label,
    year: sel.year,
    strands: sel.strands.map((s) => s.label),
    manifest: [...sel.ids],
    material: mats.map((m) => ({ ...m, refs: [...m.refs] })),
  };
}

export const briefs: FeatureDefinition<BriefsInput, BriefsOutput> = {
  feature: 'briefs',
  instructions: INSTRUCTIONS,
  input: BriefsInput,
  output: BriefsOutput,
  title: (input) => `Brief for ${input.label}`,
  build(input) {
    const seen = new Set<string>();
    const given: EntryRefWire[] = [];
    for (const m of input.material) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      given.push({ collection: m.collection, id: m.id, title: m.title });
    }
    const lines = input.material.map(entryLine).join('\n');
    const prompt = [
      `Section: ${input.label}. Story year ${input.year}.`,
      input.strands.length > 1
        ? `Strands, primary first: ${input.strands.join(' / ')}.`
        : `Strand: ${input.strands[0] ?? 'none'}.`,
      `The selected entries, one per line, grouped as the app selected them (${input.manifest.length} entries in the manifest):`,
      material('session selection', lines),
      'Write the brief from these entries only.',
    ].join('\n\n');
    return { prompt, given };
  },
  maxTurns: 2,
};

// ---------- laying the brief out (code, not Claude) ----------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * SB-5 in code: an item is canon only if Claude said so and every entry it
 * cites is canon; and an item that cites an entry selected only as "planned
 * ahead" moves under that heading, whatever section Claude put it in.
 */
function guard(output: BriefsOutput, input: BriefsInput) {
  const statusOf = new Map<string, string>();
  const groupsOf = new Map<string, Set<string>>();
  for (const m of input.material) {
    statusOf.set(m.id, m.status);
    const g = groupsOf.get(m.id) ?? new Set<string>();
    g.add(m.group);
    groupsOf.set(m.id, g);
  }
  const onlyAhead = (id: string) => {
    const g = groupsOf.get(id);
    return !!g && [...g].every((k) => k === 'plannedAhead');
  };
  const isDecided = (id: string) => !!groupsOf.get(id)?.has('decidedQuestions');
  const fix = (it: BriefItem): BriefItem => {
    // SB-4: [[...]] typed into the text is not a citation, and any cite that is
    // not one manifest ID leaves the item with no citation at all, so it is flagged.
    const text = it.text.replace(/\[\[[^\]]*\]\]/g, '').replace(/\[\[|\]\]/g, '');
    const cites = it.cites.every((id) => CITE_ID.test(id)) ? it.cites : [];
    return {
      ...it,
      text,
      cites,
      // An ID with no material (such as a chapter ID) is not canon.
      status:
        it.status === 'canon' && cites.every((id) => statusOf.get(id) === 'canon')
          ? 'canon'
          : 'planned',
    };
  };
  const ahead: BriefItem[] = output.plannedAhead.map(fix);
  /** A24: an item citing a decided question moves to a code-written Decided block. */
  const keep = (items: BriefItem[]) => {
    const kept: BriefItem[] = [];
    const decided: BriefItem[] = [];
    for (const it of items.map(fix)) {
      if (it.cites.some(onlyAhead)) ahead.push(it);
      else if (it.cites.some(isDecided)) decided.push(it);
      else kept.push(it);
    }
    return { items: kept, decided };
  };
  return {
    characters: keep(output.characters),
    worldEvents: keep(output.worldEvents),
    culture: keep(output.culture),
    sections: output.sections.map((s) => ({ heading: s.heading, ...keep(s.items) })),
    plannedAhead: ahead,
  };
}

function itemLine(it: BriefItem): string {
  const cites = [...new Set(it.cites)].map((id) => `[[${id}]]`).join(' ');
  return `- ${oneLine(it.text)}${cites ? ` ${cites}` : ''}`;
}

function canonSplit(items: BriefItem[]): string[] {
  const canon = items.filter((it) => it.status === 'canon');
  const rest = items.filter((it) => it.status !== 'canon');
  const out: string[] = [];
  if (canon.length) out.push('Canon:', ...canon.map(itemLine));
  if (rest.length) out.push('Planned or idea:', ...rest.map(itemLine));
  return out;
}

function byStrand(part: { items: BriefItem[]; decided: BriefItem[] }, strands: string[]): string[] {
  const { items } = part;
  const body = items.length
    ? strandBody(items, strands)
    : part.decided.length
      ? []
      : ['Nothing selected.'];
  if (part.decided.length) body.push('### Decided', ...part.decided.map(itemLine));
  return body;
}

function strandBody(items: BriefItem[], strands: string[]): string[] {
  if (strands.length < 2) return canonSplit(items);
  const out: string[] = [];
  const shared = items.filter((it) => !it.strand || !strands.includes(it.strand));
  for (const [i, s] of strands.entries()) {
    const mine = items.filter((it) => it.strand === s);
    if (!mine.length) continue;
    out.push(`### ${s}${i === 0 ? ' (primary)' : ''}`, ...canonSplit(mine));
  }
  if (shared.length) out.push(...canonSplit(shared));
  return out;
}

/**
 * The brief as Markdown (DB-2, SB-4 to SB-6): the three lead sections first
 * and always present, then Claude's other sections, then "Planned ahead",
 * and the over-budget and left-out notes from the selection.
 */
export function renderBrief(output: BriefsOutput, input: BriefsInput, sel?: Selection): string {
  const o = guard(output, input);
  const out: string[] = [
    `# Brief: ${input.label}`,
    '',
    `Story year ${input.year}. Written by Claude from the ${input.manifest.length} entries in the manifest; every line cites its entries.`,
  ];
  const section = (heading: string, body: string[]) => out.push('', `## ${heading}`, ...body);
  section(LEAD_SECTIONS[0].heading, byStrand(o.characters, input.strands));
  section(LEAD_SECTIONS[1].heading, byStrand(o.worldEvents, input.strands));
  section(LEAD_SECTIONS[2].heading, byStrand(o.culture, input.strands));
  let n = 4;
  for (const s of o.sections) {
    if (!s.items.length && !s.decided.length) continue;
    const heading = oneLine(s.heading).replace(/^\d+\.\s*/, '') || 'More';
    section(`${n++}. ${heading}`, byStrand(s, input.strands));
  }
  if (o.plannedAhead.length) {
    section(`Planned ahead (after ${input.year})`, o.plannedAhead.map(itemLine));
  }
  if (sel?.overBudget) {
    section('Over budget', [
      `The lead sections alone are ${sel.leadSize} characters, over the budget of ${sel.budget}. They are always kept.`,
    ]);
  }
  const left = [
    ...(sel?.skippedStrands ?? []).map((n) => `- ${n}: strand has no start year`),
    ...(sel?.omitted ?? []).map(
      (x) =>
        `- ${x.title} (${GROUP_TITLES[x.kind].toLowerCase()}): ${x.reason === 'removed' ? 'removed by you' : `over the size budget of ${sel?.budget} characters`}`,
    ),
  ];
  if (left.length) section('Left out', left);
  return out.join('\n') + '\n';
}
