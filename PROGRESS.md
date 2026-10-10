# Progress

One row per criterion. Status: `pass`, `fail`, `pending`. Evidence names the test and what it asserts, or a recorded manual check.

## Phase 0

| Item | Status | Evidence |
|---|---|---|
| Source material read | pass | `docs/PHASE0-FINDINGS.md`, 2026-10-10 |
| Spec amended and approved | pass | `SPEC.md` v0.2, A1 to A16; Tommy confirmed decisions 2026-10-10 |
| MongoDB reachable | pass | Manual: ping, write and delete on the cluster from this Mac, 2026-10-10 |
| Claude Code CLI signed in | pass | Manual: `claude auth status` reports claude.ai login, 2026-10-10 |

## M0: scaffold, test harness, fixture novel

| Criterion | Status | Evidence |
|---|---|---|
| ARCH-1 | pass | `tests/e2e/app.spec.ts` "ARCH-1 the renderer is sandboxed with no Node integration" (nodeIntegration false, contextIsolation true, sandbox true; `require`, `process`, `module` undefined; `window.api` exposes only invoke and on), "ARCH-1 the Content-Security-Policy forbids remote scripts and remote connections" (remote fetch and remote script both blocked), "ARCH-1 app.ping round-trips through window.api", "ARCH-1 window.api refuses to open a link to a host that is not allowlisted"; `tests/unit/ipc-contract.test.ts` and `tests/unit/preload.test.ts` validate both sides of every channel; `tests/unit/links.test.ts` "ARCH-1 every other link is refused". Reviewed independently 2026-10-10. |
| ARCH-2 | pass | `tests/integration/bibles.test.ts` "ARCH-2 migrate runs pending migrations in order and records the version on the registry", "refuses a bible from a newer app"; `tests/integration/search.test.ts` "ARCH-2 a Chinese title 晓曦 is found by 晓曦 and by 曦 right after the write"; `tests/unit/search.test.ts` bigram tokenizer; `tests/integration/repository.test.ts` read model loads every collection. |
| ARCH-7 | pass | `tests/unit/telemetry.test.ts` "ARCH-7 no installed package in the lockfile is a telemetry package", "no source file references a telemetry service or the crash reporter". |
| ARCH-8 | pass | `tests/integration/bibles.test.ts` "ARCH-8 connect selects the novel_companion database", "two bibles in the same database do not see each other data", "dropping a bible drops only its prefixed collections"; `tests/unit/single-database.test.ts` (no `listDatabases`, no other `.db(`); `tests/e2e/app.spec.ts` "ARCH-8 a bible created through window.api appears in bible.list and in the window", "opening a bible makes it current and shows its name in the window", "a second bible made with the New bible form can be switched to", "creating a bible with a bad or duplicate ID fails with a plain message". First review failed (create and switch unreachable); fixed and re-reviewed pass 2026-10-10. |
| Section 7 fixture | pass | `tests/unit/fixture.test.ts` "Section 7 the people table is in the fixture exactly as written", "unions and parent links match the people table", "planted structural errors S1, S2, S3 are present as data", "planted prose errors P1 and P2 are present in chapter text", "expected TL-2 answers match the spec text", two-strand chapter, categories, workbook with table and grid sheet, docx with heading and italic. Reviewer confirmed by hand that `fixtures/expected/` is written by no code. |
| T-7 | pass | `npm test` runs lint, typecheck, unit (61), integration (19), e2e (12) in order and stops on the first failure; `tests/unit/harness.test.ts`; run by the architect and by the reviewer, exit 0. |

Open notes from review (carried into M1): close the MongoClient when `connect()` throws; e2e MongoMemoryServer must be a replica set before any e2e test writes entries; add unit cases for the bible.create, bible.open, bible.current schemas.

## M1: data model, generic editing, history, undo, trash, links

| Criterion | Status | Evidence |
|---|---|---|
| ED-1 | pass | `tests/unit/manifest.test.ts` "ED-1 every section 4 entity is a collection with an editable manifest" (22 collections); `tests/integration/editing.test.ts` "ED-1 %s: create, read, update, trash, restore, each with a revision" per collection; `tests/e2e/editing.spec.ts` "ED-1 every field of every entity can be created and changed through the editor". Reviewed independently 2026-10-10. |
| ED-2 | pass | `tests/e2e/editing.spec.ts` "ED-2 a change saves on its own within one second, with no save button, and shows Saved" (elapsed under 1000 ms), "ED-2 continuous typing still saves within one second of the first change". Reviewed independently 2026-10-10. |
| ED-3 | pass | `tests/e2e/editing.spec.ts` "ED-3 fifty-one changes undo with Cmd+Z and redo with Shift+Cmd+Z" (all 51 undone and redone), "ED-3 tree edits undo to the start and redo to the end" (MongoDB asserted at both ends), "ED-3 Cmd+Z in a text field with unsaved typing undoes the typing"; `tests/integration/undo.test.ts`; `tests/unit/undo-runner.test.ts` (stale steps skipped). First review failed (redo partial, no tree edits); fixed and re-reviewed pass. Reviewed independently 2026-10-10. |
| ED-4 | pass | `tests/e2e/editing.spec.ts` "ED-4 the history drawer compares any revision with the current entry and restores it"; `tests/integration/editing.test.ts` ED-4 history, diff, restore, IPC channels. Reviewed independently 2026-10-10. |
| ED-5 | pass | `tests/e2e/editing.spec.ts` "ED-5 deleting lists what links here, moves it to the trash, and restores it with its links"; integration "ED-5 a deleted entry goes to the trash and comes back with its links intact". Reviewed independently 2026-10-10. |
| ED-6 | pass | `tests/e2e/editing.spec.ts` "ED-6 generated content and imported content are edited like any other field" (summary, manuscript text, brief, finding). Reviewed independently 2026-10-10. |
| ED-7 | pass | `tests/integration/editing.test.ts` "ED-7 a proposal changes nothing in MongoDB until approved, and approval is recorded on the proposal and a revision" (collection queried directly, revision counts), "ED-7 a proposal whose entry changed since is refused plainly, and approves after comparing again"; `tests/e2e/editing.spec.ts` ED-7 review queue approve, reject, stale refusal. First review failed (no IPC or UI); fixed and re-reviewed pass. Reviewed independently 2026-10-10. |
| ED-8 | pass | `tests/integration/editing.test.ts` "ED-8 renaming a tag updates every entry using it in one transaction, each with a revision", "ED-8 a rename that fails part way changes nothing", custom choice rename cascade and in-use refusals; `tests/e2e/editing.spec.ts` "ED-8 renaming a tag on the Lists screen updates every entry that uses it", "ED-8 renaming a union type changes the name every union shows". Reviewed independently 2026-10-10. |
| ED-9 | pass | `tests/e2e/editing.spec.ts` "ED-9 typing @ in a long text field searches, inserts a link, and the target shows Linked from"; integration ED-9 backlinks. Reviewed independently 2026-10-10. |
| ED-10 | pass | `tests/unit/warnings.test.ts` (15 ED-10 tests); `tests/integration/editing.test.ts` "ED-10 a death before birth saves and every read returns the warning", KN-2, era range, stale custom value; `tests/e2e/editing.spec.ts` "ED-10 a death date before the birth date is flagged at the field in plain words and still saves". Reviewed independently 2026-10-10. |
| T-5 | pass | `tests/e2e/editing.spec.ts` "T-5 every field of every entity is set through window.api and persists after the app restarts" (manifest-driven, Electron relaunched); `tests/unit/manifest.test.ts` "T-5 every schema field has a manifest entry and every manifest entry is a schema field, at every depth"; `tests/integration/t5.test.ts`. Reviewed independently 2026-10-10. |

Open notes from review (carried into M2): `rejectProposal` ignores `matchedCount`; `markSaved` in `undo.tsx` resets the focused field rather than the saved field.

## M2: characters and family tree

| Criterion | Status | Evidence |
|---|---|---|
| CH-1 | pass | `tests/e2e/tree.spec.ts` "CH-1 a character is created, edited with zero, one, and several families, and deleted and restored". Reviewed independently 2026-10-10. |
| CH-2 | pass | `tests/unit/character.test.ts` "CH-2 every name field, with what each other character calls them"; `tests/e2e/tree.spec.ts` "CH-2 CH-3 the character page shows every name...", "CH-2 a Chinese name shows as characters, with romanization and meaning on hover and on keyboard focus". Reviewed independently 2026-10-10. |
| CH-3 | pass | `tests/unit/ages.test.ts` (TL-3, TL-4 rules in code); `tests/unit/character.test.ts` CH-3 relatives, timeline, knowledge; `tests/e2e/tree.spec.ts` "CH-2 CH-3 the character page shows every name, the age at the current position, relatives, a personal timeline, and what they know", "CH-3 the story time drives the ages on character pages" (both ages shown). Reviewed independently 2026-10-10. |
| CH-4 | pass | `tests/unit/ages.test.ts` "CH-4 an unknown birth is reported as age unknown, never estimated"; `tests/e2e/tree.spec.ts` "CH-4 a character with an unknown birth year is reported as age unknown on the page and in the tree". Reviewed independently 2026-10-10. |
| FT-1 | pass | `tests/e2e/tree.spec.ts` "FT-1 one tree for every family, a filter to one family, and to the ancestors and descendants of one person" (13, 6, 9 nodes with names). Reviewed independently 2026-10-10. |
| FT-2 | pass | `tests/e2e/tree.spec.ts` "FT-2 FT-4 building the fixture tree by hand through tree actions gives the fixture graph and layout", "FT-2 change a link type, remove a link and undo it, and delete and restore a person through the trash". Reviewed independently 2026-10-10. |
| FT-3 | pass | `tests/e2e/tree.spec.ts` "FT-7 FT-3 a click opens the character in the inspector without leaving the tree, and an edit there redraws the node" (both directions); `tests/integration/tree.test.ts` "FT-3 a write through the one write path shows in the next tree.get at once". Reviewed independently 2026-10-10. |
| FT-4 | pass | `tests/unit/tree.test.ts` FT-4 parents, adoptive link, no family, half-siblings, "both unions of Zhou Lan are drawn, the ended one with its end year"; `tests/e2e/tree.spec.ts` "FT-4 links and unions are drawn by type...", "FT-4 a person with two unions: both draw, the ended one with its year, each child under its own union, and half-siblings". First review failed (no multi-union test); fixed and re-reviewed pass. Reviewed independently 2026-10-10. |
| FT-5 | pass | `tests/e2e/tree.spec.ts` "FT-5 the year control redraws every node for 2040, 2041, and 2075 as in the TL-2 answers, and marks unions" (loops over `fixtures/expected/tl2.json`). Reviewed independently 2026-10-10. |
| FT-6 | pass | `tests/unit/tree.test.ts` FT-6 four warnings with boundary values, "nobody can be their own ancestor"; `tests/integration/tree.test.ts` loop refusal on create, update, batch, restore; `tests/e2e/tree.spec.ts` "FT-6 warnings show beside the tree and never block; a person cannot become their own ancestor". Reviewed independently 2026-10-10. |
| FT-7 | pass | `tests/e2e/tree.spec.ts` "FT-7 FT-3 a click opens the character in the inspector without leaving the tree..." (name, years, status chip). Reviewed independently 2026-10-10. |
| FT-8 | pass | `tests/e2e/tree.spec.ts` "FT-8 pan by drag, zoom with the buttons and the wheel, collapse and expand a branch, and fit to window", "FT-8 NF-2 the tree works from the keyboard", "FT-8 a tree of 200 people across six generations redraws in under 500 ms in the renderer". Reviewed independently 2026-10-10. |
| FT-9 | pass | `tests/e2e/tree.spec.ts` "FT-9 the tree exports as a PNG image and as a PDF through a save dialog" (PNG decoded with real content; PDF light colors in dark mode). Reviewed independently 2026-10-10. |
| FT-10 | pass | `tests/unit/tree.test.ts` "FT-10 a child of Ruth / Margaret / Daniel and Lan: every existing node keeps its position"; `tests/integration/tree.test.ts` positions persist per bible; `tests/e2e/tree.spec.ts` "FT-10 adding a child to Ruth leaves every other node where it was, and stays so after a reload". First review failed (row packing shifted the Zhou family); fixed with a stored incremental layout and re-reviewed pass. Reviewed independently 2026-10-10. |

Open notes from review (carried into M3): union end-year label can overlap a node when partners are not adjacent (`tree.ts` around 736); a child of a non-adjacent union is drawn from each parent rather than a union midpoint until Tidy; Enter on a focused node selects it, collapse needs the toggle.

## M3: timeline, ages, world events, era states, story time

| Criterion | Status | Evidence |
|---|---|---|
| TL-1 | pass | `tests/unit/timeline.test.ts` "TL-1 src/shared/domain imports nothing from src/main/claude or anything else in main". Reviewed independently 2026-10-10. |
| TL-2 | pass | `tests/unit/timeline.test.ts` "TL-2 TL-4 everyoneIn(year) matches the hand-written fixture answers exactly" (loops `fixtures/expected/tl2.json`); `tests/integration/timeline.test.ts` "TL-2 timeline.year returns the hand-written answers for 2040, 2041, and 2075"; `tests/e2e/timeline.spec.ts` "TL-2 TL-5 the year view lists everyone at the story time". Reviewed independently 2026-10-10. |
| TL-3 | pass | `tests/unit/timeline.test.ts` "TL-3 with full dates, the age is one less until the birthday is reached in that year" (500-case property test). Reviewed independently 2026-10-10. |
| TL-4 | pass | `tests/unit/timeline.test.ts` "TL-4 in 2041 Margaret Hale is listed alive at 83 and flagged as dying that year", lifespan property test. Reviewed independently 2026-10-10. |
| TL-5 | pass | `tests/unit/timeline.test.ts` "TL-5 Iris Hale-Zhou by 2060 lived through five events, with her age at each"; integration "TL-5 timeline.livedThrough lists events with ages and category paths". Reviewed independently 2026-10-10. |
| TL-6 | pass | `tests/unit/timeline.test.ts` TL-6 chart lanes and the four filters; `tests/e2e/timeline.spec.ts` "TL-6 WE-1 the timeline draws every lane with a cursor; filters by family, status, category, and place", "TL-6 NF-2 an event is edited from the timeline; arrow keys move between marks and Enter opens". Reviewed independently 2026-10-10. |
| TL-7 | pass | `tests/unit/timeline.test.ts` "TL-7 Margaret Hale and Iris Hale-Zhou every five years"; `tests/e2e/timeline.spec.ts` "TL-7 compare shows two characters side by side, every 5 years or every year". Reviewed independently 2026-10-10. |
| WE-1 | pass | `tests/integration/timeline.test.ts` "WE-1 events with a full date, a year, or a range, real or invented, linked to places and characters", "WE-1 ED-8 the category list is editable". Reviewed independently 2026-10-10. |
| WE-2 | pass | `tests/integration/timeline.test.ts` "WE-2 ARCH-8 a new bible gets default decades from its lists collection", "WE-2 the fixture eras have no gaps; an edit that opens a gap is flagged and still saved"; `tests/e2e/timeline.spec.ts` "WE-2 the eras screen flags a gap after an edit and never blocks the save". Reviewed independently 2026-10-10. |
| WE-3 | pass | `tests/unit/timeline.test.ts` "WE-3 the era for a year", "WE-3 the events up to a year, in date order, and within a window". Reviewed independently 2026-10-10. |
| TM-1 | pass | `tests/e2e/timeline.spec.ts` "TM-1 TM-3 Cmd+T opens Story Time from every screen; setting 2040 updates the tree and the status bar". Reviewed independently 2026-10-10. |
| TM-2 | pass | `tests/e2e/timeline.spec.ts` "TM-2 the dialog shows everyone in the year, the era, the events, and the strands". Reviewed independently 2026-10-10. |
| TM-3 | pass | `tests/integration/timeline.test.ts` "TM-3 the story time with a full date, chapter, and strand persists in meta and reads back after reopening"; e2e TM-1 TM-3 (tree, status bar, reload); `tests/e2e/tree.spec.ts` "CH-3 the story time drives the ages on character pages". Brief default inputs are wired in M7. Reviewed independently 2026-10-10. |
| TM-4 | pass | `tests/e2e/timeline.spec.ts` "TM-4 anchors: Iris Hale-Zhou is 9 gives 2040, +10 steps to 2050, and a strand sets its year". Reviewed independently 2026-10-10. |
| TM-5 | pass | `tests/integration/timeline.test.ts` "TM-5 Use as strand year shows the change, then writes the strand through the write path with a note" (no revision on set); `tests/e2e/timeline.spec.ts` "TM-5 setting the time writes no entry; Use as strand year shows the change and writes only after approval". Reviewed independently 2026-10-10. |

NF-1 timeline queries measured under 100 ms with 5,000 generated entries (`tests/unit/timeline-perf.test.ts`); `compare`, `strandsIn`, and the place filter are measured at M10.
Open notes from review (carried into M4): character page uses the story-time year, not the full date; the Story Time dialog does not trap focus; lived-through can include an event later in a full-date death year; strand-shift preview and write logic are duplicated.

## M4: plot, culture, places, glossary, knowledge, themes, questions, log, custom sections, search

| Criterion | Status | Evidence |
|---|---|---|
| PL-1 | pending | |
| PL-2 | pending | |
| PL-3 | pending | |
| PL-4 | pending | |
| CU-1 | pending | |
| CU-2 | pending | |
| PC-1 | pending | |
| GL-1 | pending | |
| GL-2 | pending | |
| GL-3 | pending | |
| KN-1 | pending | |
| KN-2 | pending | |
| KN-3 | pending | |
| TH-1 | pending | |
| OQ-1 | pending | |
| SL-1 | pending | |
| CS-1 | pending | |
| CS-2 | pending | |
| CS-3 | pending | |
| SR-1 | pending | |
| SR-2 | pending | |
