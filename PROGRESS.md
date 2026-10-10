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
| CH-1 | pending | |
| CH-2 | pending | |
| CH-3 | pending | |
| CH-4 | pending | |
| FT-1 | pending | |
| FT-2 | pending | |
| FT-3 | pending | |
| FT-4 | pending | |
| FT-5 | pending | |
| FT-6 | pending | |
| FT-7 | pending | |
| FT-8 | pending | |
| FT-9 | pending | |
| FT-10 | pending | |
