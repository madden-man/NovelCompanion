# A47 wave 0 API: what the wave 1 builders code against

Merged to `main` 2026-10-22 (branches `a47-editable`, `a47-model`, `a47-guard`). Everything here exists and is tested; read the source only when this page is not enough.

## Editable (IP-1), `import { ... } from './editable'` in `src/renderer/src/workspace/`

`Editable` draws a stored value as text and becomes a field on click, Enter, Space or F2. Enter or blur saves, Escape reverts and refocuses, Shift+Enter is a newline in `rich`. A select saves on pick, chips save on each add or remove. The root carries `data-editable={kind}` and `data-save-state` of `idle`, `saving`, `saved`, `error`; a tick shows for 1200 ms; a visually hidden `role="status"` says "Saving" then "Saved" while the field is open. An error keeps the field open with "Not saved: <plain words>" (`role="alert"`). Chip options carry `data-value={id}`.

Shared props: `label` (accessible name, the undo noun), `placeholder`, `disabled` and `reason` (also set automatically under ARCH-6 read-only), `layout: 'inline' | 'block'` (block by default for `rich` and `chips`), `showLabel`, `testId` (closed text gets `${testId}-text`), `data-field` (the Cmd+Z rule and `markSaved`), `className`, `display(shown) => ReactNode` (for example `<Zh text={t} />`), `notes: {message, code?}[]` (ED-10 under the field), `autoOpen`, `onClose(how: 'saved' | 'unchanged')`. Every kind's `onSave` is `(next, info: { added?: AddedItem }) => Promise<void>`.

| Kind | Value | Extra props |
|---|---|---|
| `text` | `string` | `allowEmpty` (default true) |
| `year` | `number \| null` | `allowEmpty` (default false); digits and a minus, -10000 to 10000 |
| `number` | `number \| null` | `allowEmpty`, `integer`, `min`, `max` |
| `rich` | Markdown `string` | `allowEmpty`, `mode`, `size: RichSize` (default `quick`). Enter inside a list starts the next item; Cmd+Enter always saves; Enter outside a list saves; blur saves |
| `select` | `string \| null` | `options: {value,label}[]`, `onAddNew`, `allowEmpty`, `emptyLabel` |
| `chips` | `string[]` | `options`, `onAddNew`, `addLabel` (default "Add to <label>"), `pickerLabel` |
| `date` | `StoryDate \| null` | `dateBox: 'birth' \| 'death'` (default death): blank is `{unknown:true}` for birth, `null` for death |

"Add new..." is the last choice of `select` and `chips`; it becomes the field "Name of the new item for <label>", calls `onAddNew(label) => Promise<{ id, label, command? }>`, then saves the pick; the add and the pick are one undo step (a second Enter after a failed pick reuses the item).

Helpers:

- `EntryEditable`: the Editable props without `value` and `onSave`, plus `collection`, `id`, `path` (dotted, `names.full`, `strands.0.year`), `label?` (defaults to the manifest label), `entry?` (the host's copy; otherwise read and re-read on `version`), `extraPatch?(next, entry) => Doc`, `warnings?`, `onSaved?(entry)`. `data-field` defaults to `path`. Reads, writes `entry.update`, records "Changed <label> on <title>", calls `undo.markSaved`, shows the ED-10 issue.
- `saveEntryField(undo, { collection, id, path, value, label?, extraPatch?, added? })` → `{ entry, warnings }` (throws `EditableError` with the ED-10 message).
- `useEditableSave<T>({ value, write(next), command(before, after) => UndoCommand | null })` → `(next, info?) => Promise<void>` for values that are not entry fields.
- `valueCommand<T>({ label, read, write, before, after, same?, changed? })`: two `run` ops that check the stored value first.
- `useListAddNew(listId, parentId = null)`, `useEntryAddNew(collection, data(label) => Doc)`, `listOptions(list)`, `entryOptions(entries)`, `useEntryDoc(collection, id, skip?)`, `emptyMessage(label)`.
- `useAutosave(...)` in `editor.tsx` gained `adopt(entry)`: a host that both autosaves A44 boxes and has `EntryEditable` fields passes `onSaved={ed.adopt}` so a field save does not overwrite unsaved typing or double-record.
- Pure, `editable/model.ts`: `fieldLabel`, `patchForPath`, `mergeCommands`, `parseText`, `parseYear`, `parseNumber`, `parseDate`, `shownText`, `chipChoices`, `addNewReducer`, `ADD_NEW_LABEL`.
- e2e helpers in `tests/e2e/helpers.ts`: `openEditable(f)`, `fillEditable(f, text, 'Enter' | 'blur')`; `setField` understands `data-editable` of `select`, `date` and `chips`.
- A gallery of every kind opens when the address ends in `#editable-gallery` (`editable/Gallery.tsx`), for checks by hand.

Examples:

```tsx
<EntryEditable collection="chapters" id={c._id} path="title" kind="text" allowEmpty={false} />
<EntryEditable collection="eraStates" id={e._id} path="startYear" kind="year" />
<Editable kind="number" label="Picker reach in years" integer min={0} value={reach}
  onSave={useEditableSave({ value: reach, write: setReach,
    command: (b, a) => valueCommand({ label: 'Changed Picker reach', read, write: setReach, before: b, after: a }) })} />
<EntryEditable collection="worldEvents" id={ev._id} path="body" kind="rich" placeholder="Add a description" />
<EntryEditable collection="worldEvents" id={ev._id} path="categoryId" kind="select"
  options={listOptions(useList('eventCategories'))} onAddNew={useListAddNew('eventCategories')} />
<EntryEditable collection="chapters" id={ch._id} path="strands.0.characterIds" kind="chips" label="In this scene"
  options={entryOptions(useEntries('characters'))}
  onAddNew={useEntryAddNew('characters', (l) => ({ title: l, names: { full: l } }))} />
<EntryEditable collection="characters" id={id} path="birth" kind="date" dateBox="birth" showLabel placeholder="Unknown" />
```

Known: shrinking the text of an open field inside the editor pane makes Chromium smooth-scroll the pane; Editable holds the pane's scroll during edits and releases it on wheel, touch or a key outside the field.

## Lists and settings (IP-8 to IP-14), stored side

- `ListItem` is `{ id, label, parentId: string | null, color: string | null (hex), extra: Record<string, string | number> }`; old items parse with `color: null, extra: {}`.
- New lists: `regions` (events store item IDs in `worldEvents.regions`; a region name written by anything is turned into an item on write) and `ageGroups` (`extra.from`, `extra.to`; `culturalEntries.demographic` is an item ID). Status items carry `extra.kind` of `canon`, `planned` or `idea`. Seeded colours: canon #1b705f, planned #4a3aa7, idea #7a611b, researched #2a78d6, invented #b84f25. `status` and `provenance` are list item IDs (manifest kind `listItem`); the write path refuses an ID the list lacks ("Status x is not in the statuses list"); the last status of a kind cannot be removed ("Keep at least one status of kind idea."). `families.color` is a hex (`#rrggbb`, manifest kind `color`).
- Bible settings: `meta` document `bibleSettings`, read with defaults by `bibleSettings(stored)` from `src/shared/schema/settings.ts`: `cultureUnit` (`decade`, `five`, `one`), `numbers` (`timelineStart` 2025, `timelineEnd` 2100, `windowBefore` 3, `windowAfter` 1, `pickerReach` 1, `autosaveMs` 500, capped at 750 so BK-4 holds), `templates` (`chapterTitle`, `sectionTitle`, `partTitle` "Part {n}", `bookTitle` "Book {n}", `strandPresent`, `strandBackstory`, `eraName`, `briefHeadings` (9 strings), `linkTypeLabels` (a record)). Helpers: `templates(settings)`, `fillTemplate(t, n)`, `autosaveMaxMs(numbers)`, `CULTURE_UNITS`, `DEFAULT_*`. Renderer hook `useBibleSettings()` in `workspace/bibleSettings.ts`. Event `settings.changed { bible }`.
- Channels: `lists.move { listId, itemId, index } → { from, to }`, `lists.setParent { listId, itemId, parentId } → { from, to }`, `lists.setItem { listId, itemId, color?, extra? (null removes a key) } → { item }`, `lists.addItem` takes `color` and `extra`, `settings.get {} → BibleSettings`, `settings.set (partial) → BibleSettings`, `eraDefaults.get {} → { rows: {name, startYear, endYear}[] }`, `eraDefaults.set { rows }`. `timeline.chart` and `timeline.eraCoverage` take the span.
- Undo commands in `src/shared/undoCommands.ts`: `listMoveCommand`, `listParentCommand`, `listLookCommand`, `numberSettingCommand`, `cultureUnitCommand`, `templateCommand`, `eraDefaultsCommand`; `ListItemRef` carries colour and extra.
- Domain: `src/shared/domain/lists.ts` `statusKind(lists, id)`, `defaultStatus(lists, kind)`, `defaultProvenance`, `moveItem`, `parentProblem`, `isUnder`, `listColorCss`, `familyToken`, `familyColorCss`; `culture.ts` `unitOf`, `unitLabel`, `unitSpan`, `ageGroupOptions(list)` and the unit-aware decade helpers; `brief/render.ts` `isCanon`, `structuredBrief(sel, headings?)`; `backstoryGrid({ ..., base })`; renderer `useDefaultStatus()`.
- Migration 11 (schema version 11) seeds the lists, rewrites regions and family colours, moves the old brief window into `numbers.windowBefore`; summary in `meta.migration11`.
- Not yet drawn: a family hex outside the four seeded values falls back to a series token in the tree and family chips (wave 1 draws the hex); the WE-2 era coverage copy in views.tsx reads the span from the response.

## Guard (IP-15 to IP-18), stored side

- `claude.instructions.get {} → { instructions: { feature, label, default, text: string | null, footer }[] }` in `CLAUDE_FEATURES` order; `claude.instructions.set { feature, text | null } → { instruction }` (null or blank resets). The footer (shared rules plus the AI-4 sentence) is fixed. Undo: `claudeInstructionsCommand(invoke, feature, featureLabel, from, to)`.
- `claude.conversation.rename { id, title }`, `claude.conversation.clear { id }`, `claude.conversation.delete { id } → { ok: true }`; refused while Claude is answering ("Claude is still answering in this conversation. Stop it first, then try again.").
- `entry.purge { collection, id } → { entries, revisions }` (only from the trash: "Only an entry in the trash can be deleted forever. Move it to the trash first."), `trash.empty {} → { entries, revisions }`, `revisions.prune { collection?, id?, before: ISO, dryRun = false } → { count }` (a write channel even with dryRun, so refused on a read-only snapshot). None is an undo step; purge emits a `purge` change event; prune emits nothing, so reload history after it.
- `manuscript.reimport { chapterId }` → the `manuscript.read` response without `token`, plus `{ applied, entry, before }`; it re-reads the linked source and stores the result through the importer in the same call. "This chapter has no linked manuscript yet. Import it from a file first."
- IP-18: `manuscriptText`, `manuscriptSource`, `sourceFile` are system fields (the generic editor hides them; the chapter page shows the text formatted with Re-import, wave 1); every create and update path refuses them without the importer flag: "The manuscript text is imported, not edited here. Use Re-import." A proposal touching them is stored rejected with `refusal`. Restoring a revision keeps the current manuscript fields. The manuscript import and Re-import are not undo steps.
- IP-17: proposal `op: 'listAdd'` with `listAdd: { listId, label, parentId, ref }`, lists `communities`, `eventCategories`, `regions`, `languages`, `tags` (`MINTABLE_LISTS`); entries in the same set reference `new:<slug>`; `proposal.diff` shows `{ path: 'Community', before: null, after: '+ Jinan' }`; approving an entry approves its item first; a rejected item refuses dependents ("This proposal uses <label>, a new item for <List> that was rejected. ..."); an item added meanwhile (any case) is reused and `appliedItemExisted` is set. Recording: "capture: a place with no community yet proposes the community and a cultural line that uses it (IP-17, KB-6)" for "Add culture for Jinan, 2045".

## Wave 1a additions (merged 2026-10-22: `a47-outline`, `a47-grids`, `a47-desk`)

- **Editable `rich`** gained `mentionTitles?` and `onMention?` (passed to `MarkdownView` and `RichText` the way `editor.tsx` does), so a closed rich field draws `@Title` mentions as chips. `MarkdownView` takes `mentionTitles` too. Enter inside a `.ProseMirror li` continues the list; a rich field placed inside a host `<li>` still saves on Enter.
- **Strands**, `src/shared/domain/strands.ts` (the one strand helper set; `sceneOutline.ts` keeps `barStrands`, `writingStrand`, `backstoryStrand`, `patchStrand`, `newBackstoryStrand` for the outline bars): `strandsOf(chapter)`, `readStrands(chapter): StrandView[]`, `findStrand(chapter, id)`, `strandView(s)`, `setStrandYear` (a range keeps its length), `setStrandPov`, `setStrandLabel`, `setStrandPlaces`, `setStrandCharacters`, `addStrandCharacter`, `removeStrandCharacter` (each returns null when the strand is missing), `charactersChange(before, after)`, `charactersChangeLabel(...)`, `shiftStrand`.
- **Outline**: `openOutline(chapterId)` from `workspace/outline/nav.ts` switches to the Outline, scrolls the bar into view and focuses it (used by the Story time dialog). `StrandPopover.tsx` and `BooksParts.tsx` are the bar popover and the Books and parts disclosure. Scene typing is one undo step per autosave ("Typed in the scene outline"); each scene box carries `data-field="scene:<key>"`.
- **Story time dialog**: `CompareView` and `LivedThrough` take `onOpenPerson(id)`; rows keep still through `yearLinks.css` fixed column widths.
- **Grids**, `timeline/gridShared.tsx`: `useEraEdits({ eras, span, readOnly, onError })` → `{ moveEdge(id, side, delta), createInGap(gap), rename(id, name) }`; `useTitleRename(collection)`; `useEdgeDrag(ppy, readOnly, onRelease)`; `GridHeader` takes `edits`, `GridMarker` takes `title` and `onRename`. Domain: `worldGrid.ts` `edgeAt`, `snapEdge`, `moveEdge`, `neighbourAt`, `moveSharedEdge`, `bandGaps` (inside the timeline span only), `HANDLE_W`; `backstoryGrid.ts` `moveLifeEnd`, `lifeProblem(end)`, `withYear`, `allMoments`, `insertMention`, `withMentionLink`; `BackstoryMoment.linkIds`. Shift+arrows move an edge's start, Shift+Alt+arrows its end.
- **Desk**, `workspace/sessions/`: `Reimport({ chapter, onApplied? })` draws nothing without a `manuscriptSource`, shows the `manuscript.read` diff then applies through `manuscript.apply` (test IDs `reimport`, `reimport-compare`, `reimport-note`); `ManuscriptDiff({ diff })` (test ID `manuscript-diff`, used by the Manuscript tab); `overrides.ts` `useOverrides(input)` and `<OverridesBible id>` (SB-9 removals, per bible and section, in memory); `common.tsx` `OmittedList`, `removeAction`, `SelectionBody` `onKeep?`, `EventsWindow` `renderTitle?` and `footer?`; `WorldEventsStrip` `renderTitle?`; `RelevantView` `onOpenTree?`. `brief.regenerate` returns `previous`; `briefRegenerateCommand(invoke, id, title, before, after)`; `src/shared/domain/briefEdits.ts` `writtenRevisions`, `briefEdited`.
- **e2e**: `seedFixtureLists(invoke)` in `tests/e2e/helpers.ts` writes the fixture's list items a new bible lacks (regions above all); call it after `bible.open` in any spec that shows a region label. `test.seed` seeds entries with the importer flag.

## Wave 1b additions (merged 2026-10-22: `a47-continuity`, `a47-house`; `a47-vocab` follows)

- **Findings** carry `generated` (the last run's text, quote and mustChange) and `proposed` (what the check now says for a field the writer edited), both system fields defaulting to null; `refresh()` in `src/shared/domain/continuity/findings.ts` keeps a hand-edited field and records the proposal; the dismissed-finding fallback matches the generated or the stored quote; the "chapter text changed" warning compares `generated.quote`.
- **Undo runner**: a step whose `check` throws is skipped with `why: 'error'` and the notice "Undo skipped: <message> Nothing was written."; the renderer queue in `undo.tsx` catches per step so the chain never dies; undoing a delete of an entry deleted forever says the entry no longer exists.
- **Housekeeping UI**, `workspace/housekeeping.tsx`: `TypedConfirm({ word, action, onConfirm, onCancel, testId, children })` (the action stays disabled until the word is typed), `ConfirmLine({ action, keep?, onConfirm, onCancel, testId, children })`, `typedMatches`. `ProposalDiff({ view, edit?: 'label' | 'values', onEdited? })` in `review.tsx`; `proposal.edit { id, data: { label } }` renames a proposed list item (repository `editListAddLabel`: blank, long and case-insensitive duplicates refused). `PlacesView` and `GlossaryTable` take `embedded`. `CultureTab` is `'communities' | 'eras' | 'places' | 'glossary'`; the Communities tab has a unit stepper (follows the story year until stepped; "Back to the story year") and a "Step by" select over `cultureUnit`.
