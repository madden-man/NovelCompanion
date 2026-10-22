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
import { DEFAULT_BRIEF_HEADINGS } from '../../schema/settings';
import { statusKind } from '../lists';

/**
 * DB-2: the three sections every brief opens with, in this order. A47
 * (IP-14): the headings are the bible's `templates.briefHeadings`; these are
 * the defaults.
 */
export const LEAD_SECTIONS = [
  { key: 'characters', heading: DEFAULT_BRIEF_HEADINGS[0], match: /character/i },
  { key: 'events', heading: DEFAULT_BRIEF_HEADINGS[1], match: /world event|era/i },
  { key: 'culture', heading: DEFAULT_BRIEF_HEADINGS[2], match: /cultur/i },
] as const;

/** A47 (IP-9, SB-5): canon by the status item's kind, never by its ID. */
export function isCanon(it: { status: string; kind?: string }): boolean {
  return (it.kind ?? statusKind([], it.status)) === 'canon';
}

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

const HAS_CITE = /\[\[[A-Za-z0-9_-]{1,64}\]\]/;
const NOT_A_CLAIM = /^(nothing selected\.?|canon:|planned or idea:)$/i;

/** True when a line states something and so must cite its source (SB-4). */
function isUncited(line: string): boolean {
  const l = line.trim();
  if (!l || /^#{1,6}\s/.test(l)) return false;
  if (NOT_A_CLAIM.test(l.replace(/^[-*]\s+/, ''))) return false;
  return !HAS_CITE.test(l);
}

/**
 * SB-4: the lines of a Claude-written brief that cite nothing. Headings and
 * the "Nothing selected." placeholders are not claims; every other line or
 * list item must cite at least one entry. The structured brief cites by
 * construction, so this is checked on synthesized briefs.
 */
export function uncitedLines(content: string): string[] {
  const notes = appNoteLines(content);
  return content
    .split('\n')
    .filter((l, i) => !notes.has(i) && isUncited(l))
    .map((l) => l.trim().replace(/^[-*]\s+/, ''));
}

/** Sections the app writes about the selection itself, not claims about the story. */
const APP_SECTIONS = /^##\s+(left out|over budget)\s*$/i;
/** The app's own opening line under the title ("Story year 2045. ..."). */
const APP_INTRO = /^story year -?\d+\. /i;

/**
 * Line numbers the app wrote about the brief rather than the story: the
 * opening line under the title, and the "Over budget" and "Left out"
 * sections (SB-6). They name no entry in the manifest, so they cite nothing
 * by design and are never flagged.
 */
function appNoteLines(content: string): Set<number> {
  const out = new Set<number>();
  let inNotes = false;
  let beforeSections = true;
  content.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (/^##\s/.test(l)) {
      beforeSections = false;
      inNotes = APP_SECTIONS.test(l);
      return;
    }
    if (inNotes || (beforeSections && APP_INTRO.test(l))) out.add(i);
  });
  return out;
}

/**
 * DB-2: the lead sections a brief is missing or has out of order, by heading
 * text. A heading matches when it reads as the default one does, or is the
 * bible's own heading for that place (IP-14).
 */
export function missingLeadSections(
  content: string,
  names: readonly string[] = DEFAULT_BRIEF_HEADINGS,
): string[] {
  const headings = content
    .split('\n')
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, ''));
  return LEAD_SECTIONS.flatMap((s, i) => {
    const h = headings[i] ?? '';
    const own = names[i] ?? s.heading;
    return s.match.test(h) || h === own ? [] : [own];
  });
}

/** A line of the brief, with what it cites. */
function line(it: SelectedItem): string {
  const head = it.note ? `${it.title}: ${it.note}.` : `${it.title}.`;
  const body = it.detail ? ` ${it.detail}` : '';
  const refs = [it.id, ...it.refs].map((id) => `[[${id}]]`).join(' ');
  // One item is one line, so a body of several paragraphs never leaves a line without its citation (SB-4).
  return `- ${head}${body} ${refs}`.replace(/\s*\n\s*/g, ' ');
}

/** SB-5: canon first, then planned and idea material under its own label. */
function canonSplit(items: SelectedItem[]): string[] {
  const canon = items.filter(isCanon);
  const rest = items.filter((it) => !isCanon(it));
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
export function structuredBrief(
  sel: Selection,
  headings: readonly string[] = DEFAULT_BRIEF_HEADINGS,
): string {
  const h = (i: number) => headings[i] ?? DEFAULT_BRIEF_HEADINGS[i] ?? '';
  const out: string[] = [];
  out.push(`# Brief: ${sel.label}`);
  out.push('');
  out.push(
    `Story year ${sel.year}. The selected entries, with no synthesis. ${sel.ids.length} entries in the manifest.`,
  );
  const section = (heading: string, body: string[]) => {
    out.push('', `## ${heading}`, ...body);
  };
  section(h(0), strandGroups(sel, ['characters'], 'characters'));
  section(h(1), strandGroups(sel, ['era', 'eventsWindow', 'eventsFormative'], 'world events'));
  section(h(2), strandGroups(sel, ['culture'], 'this community and year'));
  section(h(3), strandGroups(sel, ['places'], 'places'));
  section(h(4), strandGroups(sel, ['moments'], 'backstory up to this year'));
  const numbered: [string, GroupKind[]][] = [
    [h(5), ['previousChapters']],
    [h(6), ['glossary', 'openQuestions']],
    [h(7), ['sessionNote']],
    [h(8), ['added']],
  ];
  for (const [heading, kinds] of numbered) {
    const items = kinds.flatMap((k) => sharedGroup(sel, k)?.items ?? []);
    const decided = kinds.includes('openQuestions')
      ? (sharedGroup(sel, 'decidedQuestions')?.items ?? [])
      : [];
    if (!items.length && !decided.length && kinds[0] === 'added') {
      continue;
    }
    const body =
      items.length || !decided.length
        ? items.length
          ? canonSplit(items)
          : ['Nothing selected.']
        : [];
    // A24: decided questions under their own heading, apart from the open ones.
    if (decided.length) body.push('### Decided', ...decided.map(line));
    section(heading, body);
  }
  const ahead = sel.strands.flatMap(
    (s) => s.groups.find((g) => g.kind === 'plannedAhead')?.items ?? [],
  );
  if (ahead.length) section(`Planned ahead (after ${sel.year})`, ahead.map(line));
  if (sel.overBudget) {
    section('Over budget', [
      `The lead sections alone are ${sel.leadSize} characters, over the budget of ${sel.budget}. They are always kept.`,
    ]);
  }
  const left = [
    ...(sel.skippedStrands ?? []).map((n) => `- ${n}: strand has no start year`),
    ...(sel.omitted ?? []).map(
      (o) =>
        `- ${o.title} (${GROUP_TITLES[o.kind].toLowerCase()}): ${o.reason === 'removed' ? 'removed by you' : `over the size budget of ${sel.budget} characters`}`,
    ),
  ];
  if (left.length) section('Left out', left);
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
  /** A47 (IP-9): the status kind SB-5 reads; absent on runs saved before A47. */
  kind?: 'canon' | 'planned' | 'idea';
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
    ...(m.kind ? { kind: m.kind } : {}),
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
export function markdownToHtml(
  md: string,
  manifest: readonly string[] | null = null,
  opts: { flagUncited?: boolean } = {},
): string {
  const ids = manifest ? new Set(manifest) : null;
  const notes = opts.flagUncited ? appNoteLines(md) : new Set<number>();
  let at = -1;
  const mark = (l: string, html: string) =>
    opts.flagUncited && !notes.has(at) && isUncited(l)
      ? `<span class="uncited" title="This line cites no entry">${html} <strong class="uncited-flag">cites nothing</strong></span>`
      : html;
  const out: string[] = [];
  let list = false;
  const close = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (const raw of md.split('\n')) {
    at++;
    const l = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      close();
      const level = (h[1] as string).length;
      out.push(`<h${level}>${inline(h[2] as string, ids)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${mark(l, inline(l.replace(/^\s*[-*]\s+/, ''), ids))}</li>`);
    } else if (l.trim() === '') {
      close();
    } else {
      close();
      out.push(`<p>${mark(l, inline(l, ids))}</p>`);
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
