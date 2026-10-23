# Remove status, provenance, source, tags, links and history (2026-10-23)

Tommy, 2026-10-23: "i don't care about status/provenance/source/tags/links/history. get rid of all that shit throughout the app." Asked how far: remove them from the model too, and remove `@` mention links as well (a mention becomes plain text with nothing stored behind it).

Amendment A52. Branch `a52-strip` off main at 2bb9ec8 (a51-kinds merged), built in waves of worktrees as in A39 and A47. This plan was surveyed on the a51-kinds worktree at 2bb677a and the SPEC text on main.

What stays: undo and redo (ED-3, `src/shared/undoCommands.ts`, `undo.ts`, `undoRunner.ts`, `undoIO.ts`; none of them reads or writes `revisions`, checked by grep), the trash and restore (`deletedAt`), snapshots (`src/main/backup/snapshots.ts`), moment kinds (A51) and the `kind` field on moments and findings, the capture router, every other import field, the manuscript lock (IP-18), reference fields such as a chapter's characters present or a union's partners, the link type lists (`unionTypes`, `parentLinkTypes`), Drive links, and external web links (`src/main/links.ts`).

## What is there today

- **Six common fields** on every entry (`commonFields` in `src/shared/schema/manifest.ts`, `EntryBase` in `src/shared/schema/common.ts`): `status` (required, an item of the `statuses` list), `provenance` (nullable, an item of the `provenance` list), `sourceNote`, `sourceRef`, `tags` (labels kept in the `tags` list) and `links` (`{ targetId, kind }`). The generic editor draws all six from the manifest, so every entry page shows them.
- **Three lists** that exist only for them: `statuses` (each item carries `extra.kind`, canon, planned or idea, read by SB-5), `provenance`, and `tags` (grown by the write path as entries use new labels, `newTags` in `repository.ts`). Seeded by `defaultLists.ts` and by migration 011.
- **Revision history.** Every write appends `{ collection, entryId, op, at, prior, note, proposalId }` to the bible's `revisions` collection (`writeChanges` in `repository.ts`). The History drawer (`history.tsx`) lists, compares and restores; IP-16 prunes per entry and for the whole bible; Delete forever and Empty trash purge an entry's revisions; the read model never loads them (`NOT_LOADED` in `readmodel/index.ts`). The brief screen reads revisions to tell a hand edit from the app's text (IP-6, `briefEdits.ts`).
- **The link index.** `outgoingRefs` (`src/shared/domain/refs.ts`) walks `links` and every reference field; `ReadModel.backlinks` inverts it. It feeds the "Linked from" panel, the Delete confirmation list, the restore notice ("with 3 entries linking to it"), Claude's `get_entry` (`linkedFrom`), the Lists screen's usage counts for families and eras, and the `missing-target` warning.
- **`@` mentions.** In a rich text box `@` opens a search picker (`RichText.tsx`); a pick inserts `@Title` and the caller adds `{ targetId, kind: 'mention' }` to `links`; a chip decoration (`MentionChips` in `richText/extensions.ts`, and `MarkdownView`) draws `@Title` of a linked entry as a chip. Backstory's Pick events inserts `@Title` into a moment's Relevant world events and adds the link (`insertMention`, `withMentionLink` in `backstoryGrid.ts`).
- **Hidden uses** found by the survey, each handled below:
  1. Re-import matches entries by `sourceRef` (IM-3: `candidates` and the High Level chapter row match in `import/changes.ts`, Word documents in `import/documents.ts`, the East Winds importer's `holdsImportedEntries` and `fromWorkbook`).
  2. Import conflict questions (IM-7) find their entry through `links` of kind `conflict` (`applyImport` in `repository.ts`); title cleanup questions use kind `about`.
  3. SB-2 step 9 selects glossary terms and open questions through `links`.
  4. CC-2's third check reads a chapter's `links` of kind `happened`; planted error S3 is a fixture link on CH6.
  5. IP-6 reads revisions to decide whether Regenerate says "This replaces your edits".
  6. KB-7 marks an offline capture question with the tag `capture`.

## Decisions

- **Typing `@` after A52: the picker goes.** `@` types an `@` and nothing opens. Why: with no link stored, the picker is only a title autocomplete, and keeping it means keeping the mention state machine, the `PickerList` wiring and its ARIA in `RichText.tsx`, the `onMention` and `mentionTitles` props through `Editable`, `fields.tsx`, `character.tsx`, `TreeView.tsx`, `MomentDialog.tsx`, `review.tsx`, `Strands.tsx` and `views.tsx`, and their tests. Removing it deletes all of that and adds nothing. If Tommy misses the shortcut, a picker that inserts the title as plain text is a small addition later. Backstory's Pick events stays and inserts the event title as plain text (the existing `insertEventTitle`), with no link.
- **Text already holding `@Title` stays as it is.** No migration rewrites prose. The `@` shows as a typed character.
- **Open questions get an About field.** `openQuestions.aboutIds: refs(ANY)`, labelled About. It is an ordinary reference field (like a chapter's characters present), not the link index. It keeps OQ-1, IM-7 conflict questions and SB-2 step 9 working. Migration 013 fills it from each question's `links`. If Tommy wants questions with no tie to entries at all, the field can go too: SB-2 step 9 then selects no questions and IM-7 matches a conflict question by its title.
- **The import location stays, hidden.** `sourceRef` leaves the entry. The location moves into the entry's existing `importSources` document as `ref` (the collection already holds per-field source records for IM-7). Nothing shows it. Without it, a re-import of the workbook would duplicate every row (IM-3).
- **CC-2 loses the "event linked as having happened" check** and S3 is withdrawn, as S2 was by SM-2. Only the fixture ever set a `happened` link.
- **The reverse index stays for reference fields.** `outgoingRefs` drops its `links` case; `ReadModel.backlinks` keeps working over reference fields for the Lists usage counts and the `missing-target` warning, and Claude's `get_entry` keeps returning `linkedFrom` from it (same name, so recordings and the SDK prompt cache are unchanged; the tool text says "the entries whose fields name it"). The "Linked from" panel, the `entry.linkedFrom` and `entry.backlinks` channels, the Delete confirmation list and the restore count go.
- **Delete keeps its confirm step**, without the list: "Move Margaret Hale to the trash?" with Keep it and Move to trash. Fewer e2e flows change than dropping the confirm.
- **The tags list goes with the tags field.** It held only tag labels.

## Change 1: survey, every file that touches a removed thing

Counts are files that change. Files with only noise hits are listed under "status usages that stay".

### `src/shared/schema` (5)

- `common.ts`: `EntryBase` loses the six fields; `Status`, `Provenance`, `Link` types go; the comment on revisions goes.
- `manifest.ts`: `commonFields` loses the six; `FieldKind` loses `tags` and `links`; `f.tags`, `f.links`, `STATUS_OPTIONS`, `PROVENANCE_OPTIONS` go; the `ANY` comment drops "links and mentions".
- `lists.ts`: `LIST_IDS` loses `statuses`, `provenance`, `tags`; `STATUS_KINDS`, `StatusKind` go; the `ListItem` comment drops "a status kind".
- `proposal.ts`: `MINTABLE_LISTS` loses `tags`; the `ListRef` comment drops "or, for a tag, its label".
- `story.ts`: `OpenQuestion` gains `aboutIds` (`f.refs('aboutIds', 'About', ANY)`); `Brief` gains `writtenContent` (`f.system`, the text the app last wrote, for IP-6).

### `src/shared/domain` (32)

- Lists and vocabulary: `lists.ts` (`statusKind`, `defaultStatus`, `defaultProvenance`, `tagsUsed`, the `tags` branches of `listUsage` and rename, the `canon` and `idea` entries of `THEME_HEX_TOKENS`), `blank.ts` (the `status` preset and the `tags` and `links` blanks).
- Links: `refs.ts` (the `links` case), `warnings.ts` (the `links.N` path rewrite), `backstoryGrid.ts` (`insertMention`, `withMentionLink`).
- Search: `searchFilters.ts` (status, provenance and tag filters).
- Timeline, tree, entries: `timeline.ts` (`status` on events, lifespans, strands, `chapterStatus`, `ChartFilters.status`, `filterChart`), `tree.ts` (`TreePerson.status`, `AddRelative.status`, `LinkExisting.status`, `linkData`), `entries.ts` (`EntryStatus`, the status filter).
- Brief and manuscript: `brief/selection.ts` (`status` and `kind` on every `SelectedItem`, `statusKind`, `linksOf`, step 9, the ignored field list), `brief/render.ts` (`isCanon`, `canonSplit`, `BriefMaterial.status` and `kind`), `briefEdits.ts` (`writtenRevisions`, `BRIEF_WRITTEN_NOTE`, `'status'` in `BRIEF_WRITTEN_FIELDS`), `manuscript.ts` (`establishedPlanned`).
- Continuity: `continuity/structural.ts` (the `happened` check), `continuity/plot.ts` (status in the material line), `continuity/changeSet.ts` (`sourceRef` in the untouched fields), `continuity/findings.ts` (`status: 'planned'` on a new finding).
- Capture: `capture.ts` (`status`, `sourceNote` and `tags: ['capture']` in `fileLocalDrafts` and the offline question), `captureRouter/drafts.ts` (eight `status: 'idea'`, the `capture` tag).
- Import: `import/build.ts`, `import/changes.ts`, `import/documents.ts`, `import/fields.ts`, `import/gridEntries.ts`, `import/guess.ts`, `import/names.ts`, `import/types.ts`, `import/values.ts`.
- Other writers of a removed field: `moments.ts` (status and `sourceRef` carried into moments), `sessionLog.ts` (`status: 'canon'`), `drive/markdown.ts` (status and provenance labels, the `## Links` section).
- `snapshots.ts`: new `MIGRATION13_SNAPSHOT_LABEL`.

### `src/shared` IPC contracts (4)

- `ipc.ts`: channels `revisions.list`, `revisions.diff`, `revisions.restore`, `entry.linkedFrom`, `entry.backlinks`; `RevisionSummary`, `WireBacklink`, `backlinks` on `entry.get`; `status` on `TreePersonWire`, `EventWire`, `PersonInYearWire`, `ChartFiltersWire`, chart lifespans; `SearchFiltersWire.status`, `.provenance`, `.tag`; search hit `status` and `provenance`; the `search.query` comment about the `@` picker; the `lists.addItem` comment about a status's kind.
- `ipcApp.ts`: `revisions.restore`, `revisions.prune` in `WRITE_CHANNELS`.
- `ipcGuard.ts`: `revisions.prune`; `PurgeCounts.revisions`.
- `ipcSession.ts`: `chapter.establishes`; `status` and `kind` on selection items and material.

### `src/main` (21)

- db: `repository.ts` (revision append, `revisions`, `history`, `revisionDiff`, `restoreRevision`, `pruneRevisions`, purge counts, `newTags`, the status and provenance list rules `keepEveryKind` and the `statuses` branches, the status and provenance settling in the vocabulary check, `defaultStatus` on conflict questions and seeded eras, `links` on conflict questions, `linkedFrom`, `fromBeforeMigration11` for restored revisions, `Change.note` and `proposalId`), `db/index.ts` (the `Revision` export), `defaultLists.ts`, `session.ts` (the migration snapshot), `migrations/index.ts`, new `migrations/013-remove-entry-metadata.ts`.
- `readmodel/index.ts`: `NOT_LOADED` and the backlinks comment.
- `search/index.ts`: `sourceNote` in the indexed fields, `doc.tags`.
- `backup/json.ts`: the status and provenance vocabulary check, the comments about revisions.
- ipc handlers: `bibleHandlers.ts` (`revisions.*`, `entry.linkedFrom`, `entry.backlinks`, `backlinks` in `entry.get`, search hit status, `status: 'idea'` on a created glossary term), `guardHandlers.ts` (`revisions.prune`), `sessionHandlers.ts` (`chapter.establishes`, `status: 'planned'` and `'canon'` on the brief and the session log).
- import: `import/eastwinds.ts` (`PLANNED`, `tags: [name]` on moment sheets, `sourceRef` reads and the `#p1` ref), `import/titleCleanup.ts` (question tags, `links`, status).
- Claude: `tools.ts`, `proposals.ts`, `features/capture.ts`, `features/captureFast.ts`, `features/importProposals.ts`, `features/briefs.ts`, `features/panel.ts` (section 4 below).

### `src/preload` (0)

`index.ts` and `api.d.ts` are generic over the channel map; nothing changes.

### `src/renderer` (43)

Listed by screen in change 7. Files: `app.css`, `theme.css`, `workspace/vocab.css`, `workspace/housekeeping.css`, `workspace/richText/richText.css`, `workspace/backstory/backstory.css`, `workspace/Zh.tsx`, `workspace/bibleSettings.ts`, `workspace/capture.tsx`, `workspace/captureChips.tsx`, `workspace/character.tsx`, `workspace/culture.tsx`, `workspace/editable/Editable.tsx`, `workspace/editor.tsx`, `workspace/fields.tsx`, `workspace/history.tsx` (deleted), `workspace/importer.tsx`, `workspace/listChip.tsx` (deleted), `workspace/listSelect.tsx`, `workspace/listsScreen.tsx`, `workspace/outline/BooksParts.tsx`, `workspace/outline/Scenes.tsx` (create sites only), `workspace/outline/Strands.tsx`, `workspace/review.tsx`, `workspace/richText/MarkdownView.tsx`, `workspace/richText/RichText.tsx`, `workspace/richText/extensions.ts`, `workspace/search.tsx`, `workspace/sessions/SessionsView.tsx`, `workspace/sessions/brief.tsx`, `workspace/sessions/common.tsx`, `workspace/sessions/manuscript.tsx`, `workspace/sessions/relevantBody.tsx`, `workspace/settingsGroups.tsx`, `workspace/timeline/StoryTimeDialog.tsx`, `workspace/timeline/TimelineView.tsx`, `workspace/timeline/WorldEventsStrip.tsx`, `workspace/timeline/gridShared.tsx`, `workspace/tree/TreeView.tsx`, `workspace/views.tsx`, `workspace/backstory/BackstoryView.tsx`, `workspace/backstory/MomentDialog.tsx`, `workspace/backups.tsx` (copy).

### `fixtures` (19)

`novel/books.json`, `chapters.json` (also the three `happened` links), `characters.json`, `culturalEntries.json`, `eraStates.json`, `families.json`, `glossaryTerms.json`, `moments.json` (also `sourceNote`, `sourceRef`), `parentLinks.json`, `parts.json`, `places.json`, `unions.json`, `worldEvents.json` (one `sourceNote`), `lists.json` (`statuses`, `provenance`); `capture/eastwinds-slice.json` (81 entries carry all six); `claude/recordings.json` (55 `status` keys in brief outputs, one `op: "link"`); `brief/supplement.json` (14 statuses, four question `links` that become `aboutIds`, the GL3 `links` patch); `expected/structural-findings.json` (S3 out, CH6 clean); `expected/sb2-selection.json` (GL3's "linked to Flood memorial walk" goes; the questions' "linked to" notes become "about"). Hand edits, per section 7: expected answers are never generated.

### `scripts` (4)

`audit-eastwinds.ts`, `audit-characters-present-eastwinds.ts` (question `tags` and `links` become `aboutIds`, `status` goes), `clean-titles-eastwinds.ts` (the revision count check goes), `set-written-eastwinds.ts` (status in the report line, the `sourceRef` comment). They are one-off scripts that already ran; they change only so they typecheck and would still write valid entries.

### Tests

- `tests/helpers` (4): `bigBible.ts`, `generatedTree.ts`, `t5.ts` (the `tags` and `links` cases go), `writeReach.ts`.
- `tests/unit` (about 35 of 70): real feature changes in `vocabulary`, `lists`, `search-filters`, `refs`, `warnings`, `brief-selection`, `brief-edits`, `manuscript`, `continuity`, `capture`, `captureRouter`, `backstory-grid`, `import-mapping`, `import-documents`, `drive`, `entries`, `timeline`, `tree`, `manifest`, `ipc-contract`, `claude-guard`, `fixture`, `moments`; the rest only lose `status: 'idea'` and the like from test data (`diff`, `undo`, `numbering`, `editable`, `tree-field-warnings`, `timeline-perf`, `search-perf`, `claude-session`). `words.test.ts` does not change: its `tags` are Datamuse's.
- `tests/integration` (26 of 29): real changes in `editing`, `repository`, `vocabulary`, `backup`, `import`, `eastwinds`, `capture`, `claude`, `continuity`, `session`, `session-claude`, `knowledge-search`, `tree`, `timeline`, `undo`, `settings-offline`, `fixture`, `migration9`, `migration10`, `migration11`, `migration12`, `bibles`, `drive`, `plot-culture`, `outline`, `nf1-perf`; new `migration13.test.ts`.
- `tests/e2e` (16 of 23 spec files): `editing`, `backstory`, `session`, `tree`, `keyboard`, `knowledge`, `settings`, `richtext`, `capture`, `continuity`, `editable`, `timeline`, `plot`, `drive`, `import`, plus `helpers.ts`.
- `tests/journey/journey.spec.ts`.
- Across tests, 349 literal `status: 'canon' | 'planned' | 'idea'`, `provenance:`, `tags: [` and `links: [` occurrences in 78 files are test data the strict schema now refuses. In `src`, 49 files write one of the six on create.

**E2e tests whose names cite a removed criterion.** ED-4: 3, ED-9: 3, MS-3: 1 (7 in all, plus 3 journey steps). Counting every e2e test that exercises a removed feature (SR-2's filters, FT-7's chip, the IP-9 status rows, the IP-16 revision rows, ED-5's link list, ED-8's tag, the moment More disclosure): 22 tests and 6 journey steps. Of the 22, 10 are deleted and 12 rewritten (change 8). T-5 and ED-1 shrink without a rewrite, since they walk the manifest.

### Status usages that stay

The word `status` also means: the status bar (`StatusBar` in `Workspace.tsx`, `.statusbar`, `.ws-status`, `.status-undo`, "shows in the status bar" in ED-3, FT-5, TM-3); `role="status"` and `aria-live` regions; the editor's save state (`SaveStatus`, `autosave`); the connection (`ConnectionStatus`, `mongo.status`, `connection.tsx`); Claude's key and disclosure (`claude.status`, `ClaudeStatusWire`, `runtime.status`) and a run's or turn's status (`running`, `done`, `stopped`, `failed`, including the capture router's runs in `capture.tsx`); Drive (`DriveStatusWire`, HTTP status in `drive/api.ts`); HTTP status in `claude/client.ts`, `claude/sdk.ts`, `words/datamuse.ts`; the undo runner's result (`applied`, `skipped`); the scene outline's `scene.status` (`Scenes.tsx`); the tree warning colours `.status.warning`; ST-1's "sign-in status". None changes. A finding's resolution is `state` (`open`, `manuscriptWins`, `rewrite`, `dismissed`) and `resolutionNote`, an open question's is `state`, a proposal's is `state`; none is the removed `status`. `storyTime.promote` (TM-5) is unrelated to MS-3's promotion. Migrations 001 to 012 keep their history text.

## Change 2: migration 013

File `src/main/db/migrations/013-remove-entry-metadata.ts`, export `removeEntryMetadata`, version 13, name "remove status, provenance, source, tags, links and revisions". `LATEST_SCHEMA_VERSION` becomes 13.

**Snapshot first.** `openBibleSession` (`src/main/db/session.ts`) takes the migration snapshot when `have < 13` (today `< MOMENT_KINDS_VERSION`), with `MIGRATION13_SNAPSHOT_LABEL = 'Before migration 13'` at the end of the label chain. The snapshot is a full JSON dump of every collection, so it holds every removed value and the whole `revisions` collection. A migration snapshot is never pruned.

**Steps, in order, all against every entry collection in `ENTRY_COLLECTIONS` that exists, trashed entries included (`{}` filter):**

1. **Keep the import location.** For each entry with a non-empty `sourceRef`, set `ref` on its `importSources` document (`_id` is the entry ID): `updateOne({ _id }, { $set: { ref }, $setOnInsert: { collection, fields: [] } }, { upsert: true })`, only where the document has no `ref` yet.
2. **Open questions keep what they are about.** For each `openQuestions` document with no `aboutIds`, set `aboutIds` to the unique `targetId`s of its `links`, any kind, in order (an empty array when it has none).
3. **Briefs keep their written text.** For each `briefs` document with no `writtenContent`, set it to its `content`. A brief edited by hand before A52 then reads as unedited once; the next Regenerate or edit sets it right.
4. **Unset the six.** `updateMany({}, { $unset: { status: '', provenance: '', sourceNote: '', sourceRef: '', tags: '', links: '' } })` per collection; count `modifiedCount`.
5. **Drop revisions.** If the bible has a `revisions` collection (`bible.collection('revisions')`, stored as `<bibleId>.revisions`), count its documents, then drop it.
6. **Remove the lists.** `deleteMany({ _id: { $in: ['statuses', 'provenance', 'tags'] } })` on `lists`, counting the items they held.
7. **Write the summary.** `meta` document `migration13` with `$setOnInsert`: `fieldsCleared` per collection, `sourceRefsKept`, `questionsAbout`, `briefsStamped`, `revisionsDropped`, `listsRemoved` (`{ statuses, provenance, tags }` item counts), `takenAt`.

**Idempotent.** Steps 1 to 3 skip documents already done, step 4 unsets nothing the second time, step 5 checks the collection exists, step 6 deletes nothing, step 7 is `$setOnInsert`. Modified times are not touched.

**What happens to East Winds.** Every status, provenance, source note, source location (as a visible field), tag and link in the East Winds bible is gone from the database, and so is every revision. The open questions keep their targets as About, and every import location is kept in `importSources`. The "Before migration 13" snapshot holds everything as it was, but restoring that snapshot in the app runs migration 13 again (`replaceBible` then `migrate` in `backup/dump.ts`), so in the app the values cannot come back; they can be read from the snapshot's JSON files or with an A51 build. Migration 011's seeding of the lists stays in its file as history.

**Older files.** A BK-3 file or snapshot at version 12 or below loads and migrates through 013 like a bible does. `readBibleFile` validates only files at the latest version, so no check changes there beyond change 5.

Test `tests/integration/migration13.test.ts`: the snapshot comes first; the six fields are gone from live and trashed entries in every collection; `sourceRef` values are in `importSources.ref` and an existing `ref` is not overwritten; questions' `links` become `aboutIds`; briefs get `writtenContent`; `revisions` is gone; the three lists are gone and the others (`momentKinds`, `regions`, `ageGroups` and the rest) are untouched; the meta summary counts match; a second run changes nothing; `LATEST_SCHEMA_VERSION` is 13. The migration 9, 10, 11 and 12 tests change `toBe(12)` to `toBe(13)` and stop at their own version (`migrate(bible, migrations.slice(0, N))`) where they assert a field 013 removes.

## Change 3: brief, continuity, manuscript

**SB-5 becomes:** "The brief never includes events after the story year except under a labelled "Planned ahead" heading." One list of material per section, no split.

- `brief/selection.ts`: `SelectedItem` loses `status` and `kind`; `statusKind` goes; step 9 uses `aboutIds` for open questions ("about Daniel Hale" in the note, as "linked to" reads today) and only the name match for glossary terms (a glossary term no longer joins through a link). Steps 1 to 8 and 10 and the `plannedAhead` group are unchanged.
- `brief/render.ts`: `canonSplit` and `isCanon` go; each section lists its items in the order selection gives. `NOT_A_CLAIM` keeps matching `Canon:` and `Planned or idea:`, so a brief saved before A52 still passes its citation check. `BriefMaterial` loses `status` and `kind`.
- `features/briefs.ts`: the output `Item` loses `status`; the instruction "Mark each item "canon" only when every entry it cites is canon; otherwise "planned"." goes; `entryLine` drops `; ${m.kind ?? m.status}`; `fix` drops the canon check and keeps the citation check; `canonSplit` goes. The stored-run parser still accepts `status` and `kind` on material and items saved before A52 and ignores them. The fixed footer (`PROMPT_FOOTER` in `prompts.ts`: role, AI-4 sentence, material rule) never mentioned status and does not change.
- `briefEdits.ts` and `sessions/brief.tsx` (IP-6): the brief writer and Start session set `writtenContent` whenever they write `content`; `briefEdited(content, [writtenContent])`. `writtenRevisions` and the `revisions.list` calls go. `BRIEF_WRITTEN_FIELDS` gains `writtenContent` and loses `status`. Regenerate still says "This replaces your edits" when the text differs from what the app wrote.
- The continuity checker loses: the S3 check `event-linked-as-happened-after-story-year` and its label (`continuity/structural.ts`); the status tag on each entry in the alignment material (`continuity/plot.ts`: `(collection; status)` becomes `(collection)`); `sourceRef` in the fields a change set leaves alone (`changeSet.ts`). CC-4's Manuscript wins still applies through the write path and is one undo step; it is no longer "recorded in revision history".
- **MS-3 is withdrawn.** Ticking Written (MS-2) offers the summary only. `establishedPlanned`, `chapter.establishes`, the promote step in `sessions/manuscript.tsx` ("Promote checked to canon", `promote-step`, `promote-list`) go; the chapter page's offer "Review its summary and promote planned entries" (`editor.tsx`) reads "Review its summary"; the Manuscript tab's "Summary and promotions" reads "Summary".

## Change 4: Claude tools and prompts

| Where | Today | After |
|---|---|---|
| `tools.ts` `search_entries` | "Returns section, ID, title, status, and a short snippet"; each hit has `status` | "Returns section, ID, title, and a short snippet"; no `status` |
| `tools.ts` `get_entry` | "with the entries that link to it"; `linkedFrom` from links and reference fields | "with the entries whose fields name it"; `linkedFrom` from reference fields only |
| `tools.ts` `propose_change` | "create an entry, change fields of one, delete one, or link one entry to another" | "create an entry, change fields of one, or delete one" |
| `proposals.ts` | `op` includes `link` (turned into a `links` update); `data.status = 'idea'` by default; `sourceRef` copied from the draft | `link` and its branch go; no default status; no `sourceRef`. New: the six removed keys are dropped from any proposal's `data` before validation, so a writer's own instructions that still mention status cannot make a proposal fail |
| `features/capture.ts` prompt | rule 4 "Set status to "idea" unless ... then "canon"."; rule 5 "set sourceNote to say it came from a capture"; rule 7 lists "or tag" | rules 4 and 5 go; rule 7 drops "or tag"; the code defaults for `status` and `sourceNote` go; the tool text drops "or link"; the KB-6 delete refusal says "A capture adds or changes entries" |
| `features/capture.ts` capture view (CR-8) | title, years, links, first 600 tokens | title, years, first 600 tokens |
| `features/captureFast.ts` | rule 5 "may only set its years, status, title or a list item field"; rule 6 "or a tag"; rule 7 status idea or canon; `op` includes `link`; `SKIP_FIELDS` and the `statuses`/`provenance` list filters | "years, title or a list item field"; no tag; rule 7 goes; no `link`; the skip set and filters go; the refusal message drops "status" |
| `features/importProposals.ts` | `op` `create`, `update`, `link`; "Every new entry has a "title" and a "status" of "idea" unless..."; `sourceRef` on each proposal | `create`, `update`; "Every new entry has a "title""; no `sourceRef` (the proposal's reason names the file) |
| `features/briefs.ts` | change 3 | change 3 |
| `features/panel.ts` | "add, change, delete, or link entries" | "add, change or delete entries" |
| `fixtures/claude/recordings.json` | brief items carry `status`; one `op: "link"` | `status` removed; the link recording becomes an `update` of `aboutIds` on a question or goes with its test |

A writer's saved instructions (IP-15, Settings) for briefs or capture may still say "canon". The output schemas no longer have the field, and the proposal sanitizer drops it, so nothing fails; Reset to default clears the old wording.

## Change 5: import and export

- **Excel and Word import** stop setting status and provenance: `guess.ts` (the `status` column guess and `fixed.status`), `gridEntries.ts` (`fixed` status and provenance), `build.ts` (the default `status` and `data.sourceRef`), `documents.ts` (`fixed: { status: 'planned' }`), `names.ts` (`status: 'planned'`, `sourceRef`), `fields.ts` (`tags` leaves the importable fields; `NOT_IMPORTABLE` drops `sourceRef`), `values.ts` (the `tags` kind). The importer screen's Status select in the mapping step goes (`importer.tsx`).
- **Re-import matching** reads the location from `importSources.ref`: `PlanInput` gains `refOf(id)`; `candidates`, the High Level `rowOf` match and Word's `documentPrefix` match use it; `applyImport` writes `ref` into the entry's `importSources` document in the same transaction as the entry (it writes that document today for the field records). IM-6 holds, unseen.
- **IM-7 conflict questions** are created with `aboutIds: [entryId]` and found again by it (`repository.ts` `applyImport`).
- **JSON export (BK-3)** writes every collection as now; `revisions` no longer exists, so it is not in the file. `validateCollections` (`backup/json.ts`) drops the status and provenance check and keeps the region check. The Backups screen copy "Writes every entry, link, revision, list, and setting" reads "every entry, list, and setting".
- **Drive Markdown export (GD-4)** (`drive/markdown.ts`): no status or provenance labels, no `## Links` section.
- **The East Winds importer** (`main/import/eastwinds.ts`): `PLANNED` goes; moment sheets lose `tags: [name]` (the sheet is still known from the import location); `holdsImportedEntries` and `fromWorkbook` read `importSources.ref`; the `${file}#p1` location goes into the import record. `titleCleanup.ts`: a cleanup question gets `aboutIds: [id]`, no tags, no status.

## Change 6: search

**SR-2 becomes:** "Results can be filtered by section, family, place, and year range."

- `searchFilters.ts`: the status, provenance and tag filters go; section, family, place and year range stay. `outgoingRefs` stays in use for the family and place filters.
- `search/index.ts`: `sourceNote` leaves the indexed text fields and `doc.tags` leaves the collected strings. The index is rebuilt on open, so nothing is migrated.
- `ipc.ts`: `SearchFiltersWire` loses `status`, `provenance`, `tag`; hits lose `status` and `provenance`.
- `search.tsx`: the Status, Provenance and Tag selects and the status chip on each hit go.

## Change 7: UI

| Screen | What goes | File |
|---|---|---|
| Every entry page and embedded editor | Status, Provenance, Source note, Source location, Tags and Links fields (drawn from the manifest, so they go with it); the "Linked from" panel (`Backlinks`, `linked-from`); the History button and drawer; the list in the Delete confirm; the `@` link; "with its links" in the trash notice | `editor.tsx`, `fields.tsx` (the `tags` and `links` field kinds), `history.tsx` (deleted) |
| Rich text boxes everywhere | the `@` picker, the mention chips, `mentionTitles`, `onMention` | `richText/RichText.tsx`, `richText/extensions.ts`, `richText/MarkdownView.tsx`, `richText/richText.css`, `editable/Editable.tsx`; callers `character.tsx`, `review.tsx`, `outline/Strands.tsx`, `views.tsx`, `TreeView.tsx`, `MomentDialog.tsx` |
| Section lists | the status chip on each row | `views.tsx` |
| Trash | "and every revision of it"; "with N entries linking to it" on restore; revision counts in the purge notice | `views.tsx` |
| Settings | the Revisions group ("Remove revisions older than") | `settingsGroups.tsx`, `housekeeping.css` |
| Backups | "link, revision" in the export copy | `backups.tsx` |
| Character page (SM-1) | the Status field in the dates line | `character.tsx` |
| Family tree (FT-7) | the node's status chip (`tchip`) and its words in the node's `aria-label`; the Status select in the add-person form; the comment that status and the rest "stay stored" | `tree/TreeView.tsx`, `app.css` (`.tchip`) |
| Search | change 6 | `search.tsx` |
| Lists | the Statuses, Provenance and Tags lists, the Kind select and `KIND_LABELS` for statuses, `COLOURED` keeps only `momentKinds`; the screen's lead line drops "statuses" and "tags" | `listsScreen.tsx` |
| Selects over a list | the swatch for statuses and provenance (`ListSwatch`) | `listSelect.tsx`, `listChip.tsx` (deleted), `vocab.css` (`.chip.list-chip`) |
| Backstory moment dialog | the whole More disclosure (`MoreFields`, its toggle, `TAGS`, `LINKS`, `HistoryDrawer`), since every field in it goes; the `@` picker in Relevant world events; Pick events inserts the title as plain text with no link; `FIELD_WORDS` for the six | `backstory/MomentDialog.tsx`, `backstory/BackstoryView.tsx`, `backstory/backstory.css` (`.bs-more*`) |
| Sessions and the desk | `StatusChip` on brief items and on open questions; the status class on event chips; the "planned if the list has one" status helper | `sessions/common.tsx`, `sessions/SessionsView.tsx`, `sessions/relevantBody.tsx` |
| Manuscript tab | the promote step | `sessions/manuscript.tsx` |
| World events strip | the status class and the status in its tooltip | `timeline/WorldEventsStrip.tsx`, `app.css` (`.we-event.planned`, `.we-event.idea`) |
| Capture (CR-6) | the Status and Source note rows in File it's diff; the `ideaStatus` prop | `captureChips.tsx`, `capture.tsx` |
| Review queue | nothing shows status of its own; a proposal's diff simply has no such field. Only the dead `onMention` prop goes | `review.tsx` |
| Importer | the Status select | `importer.tsx` |
| Create sites | `status: statusOf('idea')` and the like on every new entry | `Zh.tsx`, `culture.tsx`, `outline/BooksParts.tsx`, `outline/Scenes.tsx`, `timeline/StoryTimeDialog.tsx`, `timeline/TimelineView.tsx`, `timeline/gridShared.tsx`, `sessions/SessionsView.tsx`, `sessions/relevantBody.tsx`, `capture.tsx`, `tree/TreeView.tsx`, `backstory/BackstoryView.tsx`; `useDefaultStatus` in `bibleSettings.ts` goes |
| CSS | `.chip.canon`, `.chip.planned`, `.chip.idea` (theme.css; the desk's "writing now" chip uses `chip canon` for its look, so it gets its own class `chip now` with the same tokens), `.backlink-list`, `.revision*`, `.revision-prune`, `.mention-chip`, `.bs-more*`, `.tchip*`, `.chip.list-chip` | `theme.css`, `app.css`, `vocab.css`, `housekeeping.css`, `richText.css`, `backstory.css` |

The NF-2 contrast test reads every stylesheet; removing rules only removes pairs it checks.

## Change 8: fixture and tests

**Fixture.** Every `fixtures/novel/*.json` entry loses the six keys; `lists.json` loses `statuses` and `provenance`; CH1, CH6 and CH8 lose their `happened` links; the capture slice, the brief supplement, the recordings and the two expected files change as in the survey. The fixture loader and `tests/unit/fixture.test.ts` stop asserting `ch(6).links`.

**T-5 and ED-1.** `tests/integration/t5.test.ts`, the e2e "T-5 every field of every entity is set through window.api and persists after the app restarts" and "ED-1 every field of every entity can be created and changed through the editor" walk the manifests, so they lose six fields per entity without edits; `tests/helpers/t5.ts` drops its `tags` and `links` value cases. They gain `aboutIds` on questions for free (a `refs` field). `writtenContent` is a system field and is skipped.

**Section 7 known answers.** TL-2 does not depend on status. S3 is withdrawn (below). The SB-2 known answers change only for GL3 and the question notes.

**Unit tests**

- Deleted or emptied: `refs.test.ts` (the `links` rows), the status and provenance rows of `vocabulary.test.ts` and `lists.test.ts`, the tag rows of `lists.test.ts`, the status, provenance and tag rows of `search-filters.test.ts`, the "SB-5 canon and planned material are apart" rows of `brief-selection.test.ts` (it keeps "events after the year only appear under Planned ahead"), the MS-3 rows of `manuscript.test.ts`, the `happened` rows of `continuity.test.ts`, the `insertMention` and `withMentionLink` rows of `backstory-grid.test.ts`, `writtenRevisions` in `brief-edits.test.ts`, the `links` path rows of `warnings.test.ts`, `chapter.establishes` and `revisions.*` in `ipc-contract.test.ts`.
- Rewritten: `brief-selection.test.ts` step 9 through `aboutIds`; `brief-edits.test.ts` against `writtenContent`; `capture.test.ts` and `captureRouter.test.ts` (no status, no source note, no `capture` tag; the prompt rule checks); `import-mapping.test.ts` and `import-documents.test.ts` (no fixed status; IM-6 reads the location from the import record); `drive.test.ts` (no labels, no Links section); `entries.test.ts`, `timeline.test.ts`, `tree.test.ts` (no status filter or field); `manifest.test.ts` (the common fields are `_id`, `title`, `body`, `createdAt`, `modifiedAt`, `deletedAt`); `claude-guard.test.ts` (no statuses list).
- Test data only: the rest of the 35 files.

**Integration tests**

- Deleted: the ED-4 rows of `editing.test.ts` (history, diff, restore), the IP-16 prune rows of `editing.test.ts` and `claude.test.ts`, the ED-9 backlink rows of `editing.test.ts` and `repository.test.ts`, the "ED-8 renaming a tag" rows, the IP-9 status and provenance rows of `vocabulary.test.ts` (it keeps regions, age groups, moment kinds), the CS-2 "status, provenance, links, revisions" row of `knowledge-search.test.ts`, the MS-3 row of `session.test.ts`.
- Rewritten: `backup.test.ts` BK-3 "every collection, list, setting, and entry is identical after the round trip" (no revisions); `continuity.test.ts` "CC-1 CC-2 CC-5 the structural checks record exactly S1, and a re-run adds nothing"; `import.test.ts` and `eastwinds.test.ts` (re-import matches by the import record; conflict questions by `aboutIds`; IM-6 reads `importSources.ref`); `knowledge-search.test.ts` OQ-1 "a question is about any entry, is decided with a decision text"; `capture.test.ts`, `claude.test.ts`, `session-claude.test.ts` (no `link` op, no status in brief items, the proposal sanitizer); `repository.test.ts` (purge counts entries only; no revision per write); `tree.test.ts`, `timeline.test.ts`, `undo.test.ts`, `settings-offline.test.ts`, `plot-culture.test.ts`, `outline.test.ts`, `nf1-perf.test.ts`, `bibles.test.ts`, `drive.test.ts` (test data and assertions on removed fields); the four older migration tests (change 2).
- New: `migration13.test.ts`.

**E2e tests**

- Deleted (10): `editing.spec.ts` "ED-4 the history drawer compares any revision with the current entry and restores it", "IP-16 ED-4 History removes revisions older than a date ...", "ED-9 typing @ in a long text field searches, inserts a link, and the target shows Linked from", "IP-9 statuses and provenance recolour in place ...", "IP-9 removing a status in use is refused ..."; `keyboard.spec.ts` "NF-2 ED-4 the history drawer ..."; `richtext.spec.ts` "A44 ED-9 @ in a character box links an entry, stores @Title, and shows it as a chip"; `settings.spec.ts` "IP-16 Remove revisions older than a date ...", "IP-16 ARCH-6 on a snapshot open read-only, the prune control is off with the reason"; `backstory.spec.ts` "SM-9 A50 ED-1 ED-3 More in the dialog ...".
- Rewritten (12): `editing.spec.ts` "ED-5 Move to trash asks once, moves the entry to the trash, and restores it", "IP-16 ED-5 Delete forever asks for the title typed, then the entry is gone, and it is not an undo step", "ED-8 renaming a community on the Lists screen updates every entry that uses it"; `backstory.spec.ts` "SM-9 ED-5 Delete in the dialog moves the moment to the trash as one undo step ...", "SM-9 A33 IP-4 Pick events in the dialog lists the events within the reach and inserts the title into Relevant world events"; `knowledge.spec.ts` "SR-2 filters narrow the results by section, family, place, and year range"; `session.spec.ts` the MS-1 to MS-5 flow without the promote step, and "MS-2 SM-11 ticking Written in the chapter editor offers the summary on the Continuity checker"; `tree.spec.ts` the three FT-7 tests (a node shows name and years, no status chip; the inspector unchanged) and "SM-1 the character page is the name and Chinese name, one line of dates, families and age ...".
- Test data or a removed selector only: `capture.spec.ts` (no Status row in File it's diff), `continuity.spec.ts` (no S3 finding), `editable.spec.ts`, `timeline.spec.ts`, `plot.spec.ts`, `drive.spec.ts`, `import.spec.ts`, `helpers.ts`.
- A new e2e: "A52 an entry page shows no status, provenance, source, tags, links or history, and @ types an @ with no picker".

**Journey** (`tests/journey/journey.spec.ts`, 53 steps): the ED-4 and ED-9 steps go; "ED-8 renaming a tag" renames a community; the MS-3 step stops at the approved summary; SR-2 uses the remaining filters; ED-5 drops "with what links to it"; the step count becomes 51.

## Change 9: spec and records

### SPEC lines to delete or rewrite (main's `SPEC.md`)

- **Section 2, Definitions:** delete "**Status**: every entry is `canon` (established in a written chapter), `planned`, or `idea`." and "**Provenance**: every entry is `researched` (with a source note) or `invented`, or unset." (`[A52]`).
- **Section 4, top paragraph:** "All entries share: ID, title, body (rich text, stored as one Markdown string `[A44]`), status, provenance and source note, tags, created and modified times, links to other entries, and revision history." becomes "All entries share: ID, title, body (rich text, stored as one Markdown string `[A44]`), and created and modified times `[A52]`."
- **Section 4, Open question row:** "question, linked entries, state (open, decided), decision" becomes "question, the entries it is about, state (open, decided), decision".
- **Section 4, closing sentence:** "Lists of types (union types, parent-link types, communities, tags)" drops ", tags".
- **ED-4:** withdrawn by A52.
- **ED-5:** "Deleting moves an entry to a trash from which it can be restored with its links intact. Before deleting, the app lists the entries that link to it." becomes "Deleting moves an entry to a trash from which it can be restored, after one confirmation."
- **ED-8:** "Type lists, family names, tags, section names, and decade ranges" drops "tags, ".
- **ED-9:** withdrawn by A52 (the `@` picker, Linked from, `@Title` chips).
- **CH-3:** "the line about their place in the story and their status" becomes "the line about their place in the story".
- **FT-7:** "Each node shows name, years, and status." becomes "Each node shows name and years."; "; status, provenance, source note, source location, tags and links are not shown there and stay stored `[A45]`" is deleted.
- **TL-6:** "filterable by family, place, and status" becomes "filterable by family and place".
- **OQ-1:** "Open questions can be linked to any entry" becomes "An open question names the entries it is about".
- **MS-3:** withdrawn by A52.
- **SB-2 step 9:** "Glossary terms, themes, and open questions linked to anything selected above. Linked means: a glossary term linked to a selected entry or whose characters appear in a selected character's names; ... an open question linked to any selected entry `[A18]`. Decided questions linked the same way ..." becomes "Glossary terms whose characters appear in a selected character's names; themes with an appearance in a selected chapter or this chapter; open questions about any selected entry `[A18]` `[A52]`. Decided questions found the same way ...".
- **SB-5:** "The brief keeps canon and planned material visibly separate, and never includes events after the story year except under a labelled "planned ahead" heading." becomes "The brief never includes events after the story year except under a labelled "planned ahead" heading `[A52]`."
- **CC-2:** "; an event linked to a chapter as having happened but dated after its story year" is deleted (withdrawn by A52).
- **CC-4:** "applies all of it through the normal write path, recorded in revision history and undoable" becomes "applies all of it through the normal write path as one undo step".
- **AI-3:** "(create, change, delete, link)" becomes "(create, change, delete)".
- **CS-2:** already withdrawn by SM-12; nothing to do.
- **SR-2:** "Results can be filtered by section, status, provenance, family, place, tag, and year range." becomes "Results can be filtered by section, family, place, and year range."
- **IM-6:** "Every imported entry records its source file and location in it." gains "The location is kept with the import records for re-import (`IM-3`) and is not shown `[A52]`."
- **BK-3:** "every entry, link, revision, and setting is identical" becomes "every entry, list, and setting is identical".
- **KB-5:** "with a kind filter (one chip per kind, several at once), a status filter and a search box" drops "a status filter and".
- **KB-6:** "Filed entries default to status `idea` unless the text states canon, and their provenance names the capture." is deleted; "the entries to create, change or link" becomes "the entries to create or change"; "shows what was filed with links" stays (those are links to open the filed entries).
- **KB-7:** "saves the text as an open question tagged `capture`" becomes "saves the text as an open question".
- **SM-1:** "`familyIds`, `status`, and the common fields the app sets itself (`title`, `provenance`, `sourceRef`, `sourceNote`, `tags`, `links`)" becomes "`familyIds`, and the common fields the app sets itself (`title`)"; "birth, death, status, family and the age" drops "status, "; "a strip at its foot holds what links here, the created and changed dates, History and Move to trash" becomes "a strip at its foot holds the created and changed dates and Move to trash".
- **SM-9:** "The moment dialog is the only moment editor: a More disclosure at its foot holds status, provenance, source note and source location, tags, links and History, each change one undo step." becomes "The moment dialog is the only moment editor."; "relevant world events with the event picker" stays (the picker inserts the title as text).
- **IP-9:** "Statuses and provenance are lists. The `statuses` and `provenance` lists hold the items the chips, filters and selects show, ... the brief rules (`SB-5`) read, chosen when it is added. The write path refuses an ID that is not in the list with a plain error." becomes "`momentKinds` is a list: each kind has a label, a colour and a weight (plain or large marker, `extra.weight`), added, renamed, recoloured, reordered and removed (when unused) on the Lists screen; beside its colour the Lists screen shows the colour's contrast on the light and the dark grid with a plain note under 3:1; a seeded colour is checked by the value its token draws in each theme. The write path refuses a kind that is not in the list with a plain error `[A51]` `[A52]`." The `statuses` and `provenance` lists are withdrawn.
- **IP-16:** "the revisions go with the entry and the action is not an undo step" becomes "the action is not an undo step"; "History has "Remove revisions older than" a date per entry, and Settings has it for the whole bible, with a count shown before confirming." is deleted.
- **IP-17:** "(community, event category, region, language, tag)" drops ", tag".
- **CR-6:** ", status idea, source note "From a capture on <date>, filed without Claude."" is deleted.
- **CR-8:** "(title, years, links, and the first 600 tokens of body and backstory)" drops "links, ".
- **Section 7, planted errors:** the S3 row becomes "Withdrawn by `A52`: it needed a chapter's link to an event"; "All other chapters are clean" now includes CH6.
- **Section 9, M1:** "Data model, generic editing, history, undo, trash, links" becomes "Data model, generic editing, undo, trash".

Criteria withdrawn: 3 (ED-4, ED-9, MS-3). Criteria rewritten: 24 (ED-5, ED-8, CH-3, FT-7, TL-6, OQ-1, SB-2, SB-5, CC-2, CC-4, AI-3, SR-2, IM-6, BK-3, KB-5, KB-6, KB-7, SM-1, SM-9, IP-9, IP-16, IP-17, CR-6, CR-8), plus sections 2, 4, 7 and 9.

### The A52 amendment row

| A52 | Sections 2, 4, 7, 9; ED-4, ED-5, ED-8, ED-9, CH-3, FT-7, TL-6, OQ-1, MS-3, SB-2, SB-5, CC-2, CC-4, AI-3, SR-2, IM-6, BK-3, KB-5, KB-6, KB-7, SM-1, SM-9, IP-9, IP-16, IP-17, CR-6, CR-8 | Entries no longer have a status, a provenance, a source note, a visible source location, tags or links, and the app keeps no revision history. The `statuses`, `provenance` and `tags` lists go, and so do the History drawer, compare and restore of revisions, Remove revisions older than, the Links field, Linked from, the link list in Delete, and `@` mention links: `@` types an `@`, and Pick events on Backstory inserts the event title as text. The brief is one list of material per section with Planned ahead kept; Mark as written offers the summary only; the continuity check drops the "event linked as having happened" check and S3; search filters by section, family, place and years. Open questions gain About (`aboutIds`), the import location moves into the import records, and briefs keep the text the app wrote (`writtenContent`). Migration 013 takes a snapshot, keeps those three, unsets the six fields on every entry, drops `revisions` and removes the three lists. Undo, the trash, snapshots, moment kinds and the manuscript lock stay. Plan: `docs/REMOVE-STATUS-2026-10-23.md`. | Tommy, 2026-10-23: "i don't care about status/provenance/source/tags/links/history. get rid of all that shit throughout the app." Asked how far: remove them from the model too, and remove @ mention links as well. |

### PROGRESS

New section "## A52: no status, provenance, source, tags, links or history (sections 2, 4, 7; ED-4, ED-9, MS-3 withdrawn), 2026-10-23" with rows:

- ED-4, ED-9, MS-3: withdrawn by A52; the old rows at lines 34, 39, 168 and 398 get "withdrawn by A52".
- Section 4 and migration 013: `tests/integration/migration13.test.ts`, `tests/unit/manifest.test.ts`.
- SB-2, SB-5: `tests/unit/brief-selection.test.ts` step 9 and Planned ahead rows.
- CC-2, CC-5, section 7: `tests/integration/continuity.test.ts` "exactly S1".
- SR-2: unit and e2e rows.
- OQ-1, IM-6, IM-7: integration import and knowledge rows.
- ED-5, IP-16, BK-3, FT-7, SM-1, SM-9, IP-9, KB-6, KB-7, CR-6, CR-8: the rewritten rows.
- IP-6 (brief edit detection by `writtenContent`): `tests/unit/brief-edits.test.ts`, the e2e Regenerate row.
- A52 (the entry page has none of it, `@` types an `@`): the new e2e.
- A closing line with the suite counts and the East Winds migration summary from `meta.migration13` once Tommy has opened the bible.

### ARCHITECTURE (`docs/ARCHITECTURE.md`)

- Rule 2: "append a revision" goes from the write path.
- Rule 4: "Links between entries are stored as `{ targetId, kind }` arrays on the source entry; backlinks are derived in the read model." becomes "Entries refer to each other only through reference fields named in the manifests; the read model derives who refers to an entry (`ReadModel.backlinks`) for usage counts and the missing-target warning."
- Rule 5: "Trash and revisions" becomes "Trash"; "Every write appends to `revisions` with the full prior document." goes; the undo sentence stays.
- Rule 7 ("Status and provenance fields exist on every entry") goes.
- Line 95 (SM-1): "status," goes from the character page line.
- Manifest kinds: "`listItem` (status, provenance, a cultural line's age group)" becomes "`listItem` (a cultural line's age group, a moment's kind)"; the status and provenance refusal sentence becomes the moment kind refusal.
- Housekeeping: "`entry.purge`, `trash.empty` and `revisions.prune`" becomes "`entry.purge` and `trash.empty`"; "write no revision" goes; "a screen reloads history after it" goes.
- Bulk data rule: "(validation, revisions, the own-ancestor check)" becomes "(validation, the own-ancestor check)".
- Briefs (SB-5 line): "canon apart from planned material" goes.
- Schema versions: new paragraph "Version 13 (`013-remove-entry-metadata.ts`, A52) takes a "Before migration 13" snapshot, copies each entry's `sourceRef` into its `importSources` document as `ref`, moves open questions' link targets into `aboutIds`, sets briefs' `writtenContent` from `content`, unsets `status`, `provenance`, `sourceNote`, `sourceRef`, `tags` and `links` on every entry, trashed ones too, drops the `revisions` collection, removes the `statuses`, `provenance` and `tags` lists, and records counts in `meta.migration13`. Running it again changes nothing. Restoring a snapshot from before it runs it again."
- The stores list: `revisions` removed; `importSources` documents now carry `ref`.

## Order of work

The hard part is that the IPC contract (`ipc.ts`), `repository.ts` and `bibleHandlers.ts` are shared by every feature, and a builder that deletes a channel or an export breaks every other builder's callers. So the order is: the model first, then parallel builders that only remove callers in their own files, then one builder that removes the providers nobody calls any more. Under that rule no worktree is ever left failing typecheck.

Rules for wave 1 builders: change only your files; stop calling a removed thing, never delete its definition (a channel, a repository method, an exported function, a prop, a stylesheet rule); where a request wire still lists a removed field, wave 0 has made it optional, so stop sending it. Wave 2 deletes what is left. A builder who needs a file outside its set stops and reports.

| Wave | Builder (branch) | Scope | Files it owns | Proves it with |
|---|---|---|---|---|
| 0 | Model (`a52-model`), alone | The six fields out of `EntryBase` and `commonFields`; `statuses`, `provenance`, `tags` out of `LIST_IDS`, `defaultLists.ts`, `MINTABLE_LISTS`; `aboutIds`, `writtenContent`; migration 013, the snapshot label and `session.ts`; every create and patch site that writes one of the six, in `src`, `tests`, `scripts` and `fixtures` (mechanical); `sourceRef` into `importSources.ref` (repository `applyImport`, `import/changes.ts`, `documents.ts`, `names.ts`, `build.ts`, `eastwinds.ts`); conflict and cleanup questions on `aboutIds`; the repository's status and provenance checks, `newTags`, the statuses list rules; removed request fields made `.optional()` in `ipc.ts`; `tree.ts` planners without status; `useDefaultStatus` and its callers. Type shims (`Status`, `STATUS_KINDS`, `FieldKind` `tags` and `links`, `statusKind`, `defaultStatus`) stay exported and unused where a wave 1 file still imports them | `src/shared/schema/*`, `src/main/db/*` (all), `src/main/import/*`, `src/shared/domain/import/*`, the create sites listed in change 7, `fixtures/novel/*`, `fixtures/capture/*`, `tests/helpers/*`, test data in every test file, `scripts/*` | `npm run typecheck && npx vitest run --project unit tests/unit/manifest.test.ts tests/unit/fixture.test.ts tests/unit/import-mapping.test.ts tests/unit/import-documents.test.ts tests/unit/moments.test.ts && npx vitest run --project integration tests/integration/migration13.test.ts tests/integration/migration9.test.ts tests/integration/migration10.test.ts tests/integration/migration11.test.ts tests/integration/migration12.test.ts tests/integration/t5.test.ts tests/integration/fixture.test.ts tests/integration/import.test.ts tests/integration/eastwinds.test.ts tests/integration/repository.test.ts`. Other suites may fail until wave 1; revisions are still written in this wave, into a fresh collection |
| 1A | Entry page (`a52-entry`) | Entry editor without History, Linked from, the Delete list, `@`; rich text without picker and chips; Settings and Trash copy; character page status; section list chips | `editor.tsx`, `fields.tsx`, `richText/RichText.tsx`, `richText/extensions.ts`, `richText/MarkdownView.tsx`, `editable/Editable.tsx`, `views.tsx`, `character.tsx`, `review.tsx`, `outline/Strands.tsx`, `settingsGroups.tsx`, `backups.tsx`; `tests/e2e/editing.spec.ts`, `keyboard.spec.ts`, `richtext.spec.ts`, `settings.spec.ts`, `editable.spec.ts`; `tests/unit/editable.test.ts` | `npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.e2e.json --noEmit && npm run test:e2e -- tests/e2e/editing.spec.ts tests/e2e/keyboard.spec.ts tests/e2e/richtext.spec.ts tests/e2e/settings.spec.ts tests/e2e/editable.spec.ts` |
| 1B | Lists, search, tree (`a52-lists`) | Lists screen without the three lists; selects without swatches; search without the three filters and chips; tree node and add form without status | `listsScreen.tsx`, `listSelect.tsx`, `search.tsx`, `src/main/search/index.ts`, `tree/TreeView.tsx`; `tests/e2e/knowledge.spec.ts`, `tree.spec.ts`; `tests/unit/search.test.ts`, `search-perf.test.ts` | `npm run typecheck && npx vitest run --project unit tests/unit/search.test.ts tests/unit/search-perf.test.ts && npm run test:e2e -- tests/e2e/knowledge.spec.ts tests/e2e/tree.spec.ts` |
| 1C | Backstory and capture (`a52-capture`) | The moment dialog without More and its picker; Pick events as plain text; capture and the router without status, source note and the `capture` tag; capture prompts | `backstory/MomentDialog.tsx`, `backstory/BackstoryView.tsx`, `src/shared/domain/backstoryGrid.ts`, `captureChips.tsx`, `capture.tsx`, `src/shared/domain/capture.ts`, `captureRouter/drafts.ts`, `src/main/claude/features/capture.ts`, `captureFast.ts`; `tests/e2e/backstory.spec.ts`, `capture.spec.ts`; `tests/unit/capture.test.ts`, `captureRouter.test.ts`, `backstory-grid.test.ts`; `tests/integration/capture.test.ts` | `npm run typecheck && npx vitest run --project unit tests/unit/capture.test.ts tests/unit/captureRouter.test.ts tests/unit/backstory-grid.test.ts && npx vitest run --project integration tests/integration/capture.test.ts && npm run test:e2e -- tests/e2e/backstory.spec.ts tests/e2e/capture.spec.ts` |
| 1D | Sessions, brief, manuscript, continuity (`a52-brief`) | Change 3 in full, including its own contract file and handlers | `src/shared/domain/brief/*`, `briefEdits.ts`, `manuscript.ts`, `continuity/structural.ts`, `continuity/plot.ts`, `continuity/changeSet.ts`, `src/shared/ipcSession.ts`, `src/main/ipc/sessionHandlers.ts`, `src/main/claude/features/briefs.ts`, `src/main/continuity/index.ts`, `sessions/*.tsx`, `timeline/WorldEventsStrip.tsx`, `fixtures/brief/*`, `fixtures/expected/*`, the brief entries of `fixtures/claude/recordings.json`, `fixtures/novel/chapters.json` (`happened` links); tests `brief-selection`, `brief-edits`, `manuscript`, `continuity` (unit), `session`, `session-claude`, `continuity` (integration), `session.spec.ts`, `continuity.spec.ts` | `npm run typecheck && npx vitest run --project unit tests/unit/brief-selection.test.ts tests/unit/brief-edits.test.ts tests/unit/manuscript.test.ts tests/unit/continuity.test.ts && npx vitest run --project integration tests/integration/session.test.ts tests/integration/session-claude.test.ts tests/integration/continuity.test.ts && npm run test:e2e -- tests/e2e/session.spec.ts tests/e2e/continuity.spec.ts` |
| 1E | Import, export, Claude tools (`a52-io`) | Change 4 (except capture and briefs) and what wave 0 leaves of change 5: the importer's Status select, the JSON and Drive export, Claude's tools and proposals | `src/main/claude/tools.ts`, `proposals.ts`, `features/importProposals.ts`, `features/panel.ts`, `src/main/backup/json.ts`, `src/shared/domain/drive/markdown.ts`, `importer.tsx`, the non-brief entries of `fixtures/claude/recordings.json`; tests `drive` (unit), `backup`, `claude`, `drive` (integration), `import.spec.ts`, `drive.spec.ts` | `npm run typecheck && npx vitest run --project unit tests/unit/drive.test.ts && npx vitest run --project integration tests/integration/backup.test.ts tests/integration/claude.test.ts tests/integration/drive.test.ts && npm run test:e2e -- tests/e2e/import.spec.ts tests/e2e/drive.spec.ts` |
| 2 | Providers and dead code (`a52-contract`), alone, after 1A to 1E merge | Delete what nobody calls: `revisions.*`, `entry.linkedFrom`, `entry.backlinks` and their handlers; the revision write path and methods in `repository.ts`; `Change.note`; `PurgeCounts.revisions`; `status` on the tree, timeline and search wires and in `tree.ts`, `timeline.ts`, `entries.ts`, `searchFilters.ts`; the `links` case in `refs.ts` and `warnings.ts`; `NOT_LOADED`; the type shims; `history.tsx`, `listChip.tsx`; the `onMention` and `mentionTitles` props; every dead CSS rule in change 7 | `src/shared/ipc.ts`, `ipcApp.ts`, `ipcGuard.ts`, `src/main/ipc/bibleHandlers.ts`, `guardHandlers.ts`, `src/main/db/repository.ts`, `db/index.ts`, `readmodel/index.ts`, `src/shared/domain/refs.ts`, `warnings.ts`, `searchFilters.ts`, `lists.ts`, `tree.ts`, `timeline.ts`, `entries.ts`, `blank.ts`, `src/shared/schema/*`, the two deleted files, the stylesheets; tests `refs`, `warnings`, `search-filters`, `lists`, `vocabulary`, `ipc-contract`, `entries`, `timeline`, `tree`, `claude-guard` (unit), `editing`, `repository`, `vocabulary`, `knowledge-search`, `tree`, `timeline`, `undo`, `settings-offline` (integration), `tests/helpers/writeReach.ts` | `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration`, and `grep -rn "revisions\|linkedFrom\|statusKind\|STATUS_KINDS\|'statuses'\|onMention" src` finds only migration history |
| 3 | Records (`a52-records`), in parallel with wave 2 | Change 9 | `SPEC.md`, `PROGRESS.md` (rows filled after wave 4), `docs/ARCHITECTURE.md` | `npm run lint` (prettier); a grep of the three files for the character U+2014 finds nothing |
| 4 | Integration (`a52-strip`) | Merge, the journey rewrite, the full suite, a fresh-context review against SPEC | `tests/journey/journey.spec.ts`, any fix the full run asks for | `npm test` (lint, typecheck, unit, integration, e2e hidden with `NOVEL_COMPANION_HIDDEN=1`), then `npm run test:journey` |

**Where a wave breaks something until another lands.**

- After wave 0 alone, typecheck is green but behaviour is half done: code that reads a removed field directly still runs and finds nothing (the search filters, the tree chip, the brief's canon split, the History drawer over a fresh `revisions` collection), so those suites fail. That is expected, and it is why wave 0's proof is the listed subset. Wave 1 builders start from wave 0's merge.
- Wave 1 builders never delete a shared definition, so none breaks another. The one contract file a wave 1 builder owns, `ipcSession.ts`, has no caller outside 1D.
- `fixtures/claude/recordings.json` is split by entry between 1D (brief recordings) and 1E (the rest). The two edits touch different array items; the integration wave takes both. If the merge conflicts, 1E rebases on 1D.
- `fixtures/novel/chapters.json` is edited by wave 0 (the six fields) and 1D (the `happened` links): sequential, no overlap.
- Wave 2 runs alone because it touches the three shared files. It is mechanical by then: typecheck tells it every leftover.

## Risks

1. **Nothing removed can come back inside the app.** Restoring the "Before migration 13" snapshot runs 013 again. Recommendation: before Tommy opens East Winds on an A52 build, take a manual snapshot and a BK-3 JSON export with the A51 build, and keep both folders; an A51 build can read them.
2. **No more "restore an earlier version" of an entry.** Undo covers the session only; after that, snapshots are the only way back. Recommendation: keep daily snapshots on and consider raising the keep count (BK-1, a setting) from 30.
3. **Re-import needs the import location.** Tommy said "source"; taking `sourceRef` out entirely would make the next workbook import duplicate every row. Recommendation: keep it hidden in `importSources.ref`, as planned, and tell Tommy.
4. **Open questions lose their tie to entries unless About stays.** OQ-1, IM-7 conflict questions and the brief's question step depend on it. Recommendation: keep About (`aboutIds`); drop it only if Tommy says questions should stand alone.
5. **The continuity check loses one structural check (S3).** Recommendation: accept; only the fixture used it.
6. **`@Title` text stays in East Winds prose with nothing behind it.** Recommendation: leave the text; a later find and replace can strip the `@` if Tommy wants.
7. **Things that are not what Tommy meant and must stay:** the status bar, a finding's resolution (`state`, `resolutionNote`), the `kind` on moments and findings, the capture router's run status, Drive links, the parent link and union type lists, reference fields such as characters present, the save state, the Story time promote (TM-5). Recommendation: confirm with Tommy in one line before wave 0; the plan touches none of them.
8. **The Lists usage counts and the missing-target warning depend on the reverse index.** Removing "links" could tempt a builder to remove the index. Recommendation: wave 2 keeps `ReadModel.backlinks` over reference fields, as planned.
9. **Saved Claude instructions may still say canon or status.** Recommendation: the proposal sanitizer and the schemas make it harmless; mention Reset to default in the release note.
10. **Briefs edited by hand before A52 lose the "This replaces your edits" warning once** (migration 013 stamps `writtenContent` with the current text). Recommendation: accept.
11. **Capture filings are no longer marked "idea" or "from a capture".** Tommy asked for this; the review queue and the Filed list still show what was filed. Recommendation: accept.
12. **Wave 1 builders may drift into shared files.** Recommendation: each brief names its file set and the "remove callers, never definitions" rule; the integration review checks every diff stays inside its set.
