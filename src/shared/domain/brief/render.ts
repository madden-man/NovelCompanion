/**
 * Turning a selection into a brief (SB-4, SB-5, SB-7, DB-2) and checking a
 * brief's citations. Pure text functions: the structured brief is what the
 * app shows when Claude is unavailable, and the material list is the only
 * thing Claude is given when it is available.
 *
 * Citations are written `[[ID]]`. Every line of a brief cites the entries it
 * came from; code checks each cited ID against the manifest (SB-4).
 */
import { GROUP_TITLES, allGroups } from './selection';
import type { GroupKind, Selection, SelectedItem, SelectionGroup } from './selection';

/** DB-2: the three sections every brief opens with, in this order. */
export const LEAD_SECTIONS = [
  { key: 'characters', heading: '1. Characters and their ages', match: /character/i },
  { key: 'events', heading: '2. World events ongoing', match: /world event|era/i },
  { key: 'culture', heading: '3. Cultural expectations', match: /cultur/i },
] as const;

const CITE = /\[\[([A-Za-z0-9_-]{1,64})\]\]/g;

/** Every ID a brief cites, once each, in the order first cited. */
export function citedIds(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(CITE)) {
    const id = m[1] as string;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** SB-4: cited IDs that are not in the manifest. The brief flags each one. */
export function citationProblems(content: string, manifest: readonly string[]): string[] {
  const ids = new Set(manifest);
  return citedIds(content).filter((id) => !ids.has(id));
}

/** DB-2: the lead sections a brief is missing or has out of order, by heading text. */
export function missingLeadSections(content: string): string[] {
  const headings = content
    .split('\n')
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, ''));
  return LEAD_SECTIONS.filter((s, i) => !s.match.test(headings[i] ?? '')).map((s) => s.heading);
}

/** A line of the brief, with what it cites. */
function line(it: SelectedItem): string {
  const head = it.note ? `${it.title}: ${it.note}.` : `${it.title}.`;
  const body = it.detail ? ` ${it.detail}` : '';
  const refs = [it.id, ...it.refs].map((id) => `[[${id}]]`).join(' ');
  return `- ${head}${body} ${refs}`.replace(/\s+\n/g, '\n');
}

/** SB-5: canon first, then planned and idea material under its own label. */
function canonSplit(items: SelectedItem[]): string[] {
  const canon = items.filter((it) => it.status === 'canon');
  const rest = items.filter((it) => it.status !== 'canon');
  const out: string[] = [];
  if (canon.length) out.push('Canon:', ...canon.map(line));
  if (rest.length) out.push('Planned or idea:', ...rest.map(line));
  return out;
}

function strandGroups(sel: Selection, kinds: GroupKind[], what: string): string[] {
  const out: string[] = [];
  const many = sel.strands.length > 1;
  for (const s of sel.strands) {
    const items = s.groups.filter((g) => kinds.includes(g.kind)).flatMap((g) => g.items);
    if (many) out.push(`### ${s.label}${s.primary ? ' (primary)' : ''}`);
    out.push(...(items.length ? canonSplit(items) : [`Nothing selected for ${what}.`]));
  }
  return out;
}

function sharedGroup(sel: Selection, kind: GroupKind): SelectionGroup | undefined {
  return sel.shared.find((g) => g.kind === kind);
}

/**
 * SB-7: the selection as a structured brief with no synthesis. The DB-2 lead
 * sections come first; canon and planned material are kept apart (SB-5);
 * events after the story year appear only under "Planned ahead".
 */
export function structuredBrief(sel: Selection): string {
  const out: string[] = [];
  out.push(`# Brief: ${sel.label}`);
  out.push('');
  out.push(
    `Story year ${sel.year}. The selected entries, with no synthesis. ${sel.ids.length} entries in the manifest.`,
  );
  const section = (heading: string, body: string[]) => {
    out.push('', `## ${heading}`, ...body);
  };
  section(LEAD_SECTIONS[0].heading, strandGroups(sel, ['characters'], 'characters'));
  section(
    LEAD_SECTIONS[1].heading,
    strandGroups(sel, ['era', 'eventsWindow', 'eventsFormative', 'eventsPlaces'], 'world events'),
  );
  section(LEAD_SECTIONS[2].heading, strandGroups(sel, ['culture'], 'this community and year'));
  section('4. Places', strandGroups(sel, ['places'], 'places'));
  section('5. Who knows what', strandGroups(sel, ['knowledge', 'povUnknown'], 'knowledge'));
  const numbered: [string, GroupKind[]][] = [
    ['6. Previous chapters', ['previousChapters']],
    ['7. Beats', ['beats']],
    ['8. Glossary, themes, and open questions', ['glossary', 'themes', 'openQuestions']],
    ['9. Custom entries', ['custom']],
    ['10. Last session note', ['sessionNote']],
    ['11. Added by you', ['added']],
  ];
  for (const [heading, kinds] of numbered) {
    const items = kinds.flatMap((k) => sharedGroup(sel, k)?.items ?? []);
    if (!items.length && (kinds[0] === 'custom' || kinds[0] === 'added')) continue;
    section(heading, items.length ? canonSplit(items) : ['Nothing selected.']);
  }
  const ahead = sel.strands.flatMap(
    (s) => s.groups.find((g) => g.kind === 'plannedAhead')?.items ?? [],
  );
  if (ahead.length) section(`Planned ahead (after ${sel.year})`, ahead.map(line));
  if (sel.omitted.length) {
    section(
      'Left out',
      sel.omitted.map(
        (o) =>
          `- ${o.title} (${GROUP_TITLES[o.kind].toLowerCase()}): ${o.reason === 'removed' ? 'removed by you' : `over the size budget of ${sel.budget} characters`}`,
      ),
    );
  }
  return out.join('\n') + '\n';
}

/** One entry as Claude receives it for a brief (SB-4): only what the selection holds. */
export interface BriefMaterial {
  id: string;
  collection: string;
  group: GroupKind;
  strand: string | null;
  title: string;
  status: string;
  note: string;
  detail: string;
  refs: string[];
}

/** SB-4: the manifest's contents, the only material a synthesized brief may draw on. */
export function briefMaterial(sel: Selection): BriefMaterial[] {
  const out: BriefMaterial[] = [];
  for (const s of sel.strands) {
    for (const g of s.groups) {
      for (const it of g.items) out.push({ ...it, group: g.kind, strand: s.label });
    }
  }
  for (const g of sel.shared) {
    for (const it of g.items) out.push({ ...it, group: g.kind, strand: null });
  }
  return out.map((m) => ({
    id: m.id,
    collection: m.collection,
    group: m.group,
    strand: m.strand,
    title: m.title,
    status: m.status,
    note: m.note,
    detail: m.detail,
    refs: m.refs,
  }));
}

/** How many entries each group holds, for counts in the interface. */
export function groupCounts(sel: Selection): Record<GroupKind, number> {
  const out = Object.fromEntries(Object.keys(GROUP_TITLES).map((k) => [k, 0])) as Record<
    GroupKind,
    number
  >;
  for (const g of allGroups(sel)) out[g.kind] += g.items.length;
  return out;
}

// ---------- Markdown to HTML, for the brief view and the PDF export ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string, manifest: ReadonlySet<string> | null): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([A-Za-z0-9_-]{1,64})\]\]/g, (_m, id: string) =>
      manifest && !manifest.has(id)
        ? `<span class="cite bad" data-cite="${id}" title="Not in the selection">${id} not in the selection</span>`
        : `<span class="cite" data-cite="${id}">${id}</span>`,
    );
}

/**
 * A small Markdown renderer for briefs: headings, lists, paragraphs, bold,
 * and citations. Everything is escaped first, so brief text can never inject
 * markup. With a manifest, citations outside it are marked (SB-4).
 */
export function markdownToHtml(md: string, manifest: readonly string[] | null = null): string {
  const ids = manifest ? new Set(manifest) : null;
  const out: string[] = [];
  let list = false;
  const close = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (const raw of md.split('\n')) {
    const l = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      close();
      const level = (h[1] as string).length;
      out.push(`<h${level}>${inline(h[2] as string, ids)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(l.replace(/^\s*[-*]\s+/, ''), ids)}</li>`);
    } else if (l.trim() === '') {
      close();
    } else {
      close();
      out.push(`<p>${inline(l, ids)}</p>`);
    }
  }
  close();
  return out.join('\n');
}

/** A standalone page for printing a brief to PDF (SB-8). */
export function briefPrintPage(titleText: string, md: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(titleText)}</title><style>
body { font: 11pt/1.45 Georgia, serif; color: #1d1d1f; background: #ffffff; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 8pt; }
h2 { font-size: 13pt; margin: 14pt 0 4pt; }
h3 { font-size: 11pt; margin: 10pt 0 2pt; }
ul { margin: 2pt 0 6pt 16pt; padding: 0; }
li { margin: 0 0 3pt; }
.cite { font: 8pt ui-monospace, Menlo, monospace; color: #444; }
.cite.bad { color: #b00020; font-weight: bold; }
</style></head><body>${markdownToHtml(md)}</body></html>`;
}

/** A file name for an exported brief: letters, digits, spaces, dashes. */
export function briefFileName(titleText: string): string {
  const base = titleText
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || 'Brief';
}
