# A48 wave 1 API: what the box builder codes against

Merged to `main` 2026-10-22 (branches `a48-fast` and `a48-router`). Everything here exists and is tested; read the source only when this page is not enough.

## The router, `src/shared/domain/captureRouter/` (CR-1 to CR-5)

```ts
import { buildIndex, routeCapture, LEXICON, localSourceNote } from '../../../shared/domain/captureRouter';

buildIndex(input: RouterIndexInput, lexicon?: Lexicon): RouterIndex
routeCapture(text: string, index: RouterIndex, options: RouteOptions, lexicon?: Lexicon): CaptureRouting
```

- `RouterIndexInput` is `{ lists, entries: { characters, places, culturalEntries, moments, glossaryTerms }, timelineEnd }` with the store's plain documents (`useEntries(c)` for each, `useList` for every list the store holds, `useBibleSettings().numbers.timelineEnd`). Trashed entries are left out by the builder.
- `RouteOptions` is `{ storyYear, povCommunityId, hints }`. Hints are `CaptureHint[]` (`types.ts`): `{ fact, route?, section?, communityId?, characterId?, categoryId?, demographic?, startYear?, endYear? }`. A hint ID that is not in the index is ignored and the fact gets a reason saying so.
- `CaptureRouting.facts[]`: each `CaptureFact` carries `text`, `years { start, end, source }`, `candidates[]`, `scores`, `cues` (plain labels under 50 characters, for the card), `ranked`, `section`, `share`, `margin`, `communities[] { id, why }` (the writing strand's guess has `why === WRITING_STRAND` and is never filled into a draft), `missing[]`, `asks[]`, `reasons[]`, `drafts[]`, `route`.
- Drafts are `CaptureDraft[]` in main's `ProposalDraft` shape: `{ op: 'create', collection, data }` with `status: 'idea'` and no source note (the box adds `localSourceNote(date)`), and `{ op: 'listAdd', listId, label, ref: 'new:slug' }` for a new region, with the ref used as the value in the draft that needs it. A missing required field is left out of `data`. Long texts (`body`, `question`, `usageNote`) are the sentence as typed, Markdown (A44).
- Missing fields and asks: cultural data `communityId` (ask "Community"), moment `characterId` ("Character"), place `title` ("Place name"), glossary `characters` ("Term"), character `names.full` ("Name"); a world event's missing `categoryId` is a judgment, Route B, never asked.
- A first name that is also an English word (Mark, Dawn) matches only with a capital in the text; full names and Chinese names match in any case, so "mark moves to seattle" asks for the character.
- A fact whose years end before they start, or start after the timeline end, carries a reason and goes to Route B; so does a second person named in a moment, an unknown name, and a hint whose ID is not in the index.
- Empty text gives `facts: []`. A capture of more than 50 sentences is refused by main; the box should refuse it first with the same words.
- Re-route after a chip change by calling `routeCapture` again with a hint for that fact; it is cheap (about 2 ms with a thousand entries).

Example:

```ts
const index = buildIndex({ lists, entries: { characters, places, culturalEntries, moments, glossaryTerms }, timelineEnd: 2100 });
const { facts } = routeCapture('Teenagers in Jinan treat an American college degree as a joke by the 2070s', index, { storyYear: 2066, povCommunityId: null, hints: [] });
// facts[0].route === 'local'; facts[0].section === 'culturalEntries'; facts[0].asks === []
// facts[0].drafts[0] === { op: 'create', collection: 'culturalEntries', data: { title: 'Teenagers in Jinan treat an American college degree as a joke', communityId: 'jinan-shandong', demographic: '0-18', startYear: 2070, endYear: 2100, body: 'Teenagers in Jinan treat an American college degree as a joke by the 2070s', status: 'idea' } }
```

## `claude.capture` with hints (CR-9), main side

Request `{ runId, text, storyTime, hints?: CaptureHint[] }`. Main reruns the router on the text with the hints. Facts on `local` are skipped (the box files them); `fast` facts go to `captureFast` in one run; `full` facts go to `capture` in one run.

Response `CaptureStarted` (`src/shared/claude.ts`):

```ts
{ runId: string; conversationId: string | null; started: boolean;
  runs: { route: 'fast' | 'full'; runId: string; conversationId: string; facts: number[] }[] }
```

- One route needed: the run keeps the request's `runId`.
- Both needed: `<runId>-fast` and `<runId>-full` (the base cut so each is at most 64 characters); the top-level `runId` and `conversationId` are the fast run's. Listen to every run in `runs`.
- Only local facts: `{ runId, conversationId: null, started: false, runs: [] }`, no stream events, nothing saved. Do not wait for a finished event.
- Errors, plain words: the second run could not start (the first is stopped, nothing filed), or more than 50 facts.
- `claude.stop` with the request's `runId` stops the split runs too, even when the Stop arrives before the split.

## `captureFast` (CR-7)

Feature `captureFast`, label "Capture, fast file", default model `claude-haiku-5-5`, no tools, instructions editable in Settings (IP-15). Output saved on the run:

```ts
{ proposals: { fact: number; op; collection; targetId; fields: string /* JSON object text */; link; listId; label; parentId; ref; reason }[];
  summary: string;
  cannotPlace: { fact: number; reason: string }[] }
```

Proposals are queued through the same validation as `propose_change` (status idea, source note "From a capture on <date>.", a delete refused, a change to a text or array field of an existing entry refused). The proposals of a fact listed in `cannotPlace` are dropped; the box offers Ask Claude instead (Route C) on those cards only, with the reason.

## Route C (CR-8)

Today's capture with the lists trimmed, a candidates block per fact, and a capture view of `get_entry` (the whole entry with `body` and `backstory` cut at 2,400 characters; a proposal that replaces a cut field is refused with a plain reason). Nothing for the box to do differently: proposals stream and wait for approval as before.
