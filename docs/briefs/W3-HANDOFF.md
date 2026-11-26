# W3 handoff: the pocket and the notebook (A55), 2026-11-25

Branch `worlds-w3`, draft PR #1 against main. Never push main.

## Done
- Everything in SPEC section 5.26 (NB-1 to NB-9), with tests; PROGRESS rows for A55 at `pending`.
- The Notebook list on the Places tab row editor (Cultural data), with its e2e test.

## The two e2e failures are pre-existing
`tests/e2e/backstory.spec.ts:586` "SM-9 a click on an empty spot in a row adds a moment..." and `tests/e2e/tree.spec.ts:1055` "SM-1 the character page is ... nothing else" fail the same way on origin/main db286e5 (throwaway worktree, whole files, `--workers=1`): backstory at `pointAt` (`document.elementFromPoint` is not the track), tree with the window `[1200, 770]` for `[1200, 800]`. On main the tree test passes when run alone, so an earlier test in the file leaves the window 30px short. Neither is touched by this branch.

## Review fixes (after the review of 41611b3)
One bad page never halts a pull (hashed signature, values cut on arrival, per-page skip and log); a thread whose last line is deleted goes to the trash; lines record ink, character or other voice; first family's colour only; trashed entries not linked; absent year is no year known; tests for research pages, threads, the kept mark and a read-only snapshot never starting the bridge. Details and test names in PROGRESS.md.

## Last full `npm test` on the branch
Lint and typecheck clean; unit 848/848 (69 files); integration 343/343 (31 files); e2e 298 passed, 2 failed (the two above), 38 not run (the rest of those two serial files).

## Decisions taken
- `notebookPages` is outside `entrySchemas`, read-only with its own reader.
- World ID = bible ID with `_` as `-`; a clash leaves the bible unpublished.
- Decided questions in the pocket: those changed after the first publish (meta `bridge.since`).
- Trashed notebook pages have no Restore; they come back when the phone resends.
- Lines on a bible question with no page row make a thread named for the question.
- Chapters linked by title as written or "chapter N".
- The row-editor Notebook list is for places only; the tree inspector's character editor has none.

## How to resume
Nothing open for W3 beyond review. The reviewer flips the PROGRESS rows.
