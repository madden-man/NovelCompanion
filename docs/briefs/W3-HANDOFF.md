# W3 handoff: the pocket and the notebook (A55), 2026-11-25

Branch `worlds-w3`, draft PR against main. Never push main.

## Done
- SPEC section 5.26 (NB-1 to NB-9), section 4 Notebook page row, SM-1 and SR-1 notes, W3 milestone row, amendment A55. ARCHITECTURE "The phone bridge, A55" and schema version 15.
- `src/shared/bridge.ts` (contract copy, world ID), `src/shared/domain/pocket.ts`, `src/shared/domain/notebook.ts` (assemble, link, plan, rows), `src/shared/schema/notebook.ts`, `src/shared/ipcNotebook.ts`.
- Migration 015 (`notebookPages` and indexes), `src/main/db/bridge.ts` (BridgeStore), `src/main/bridge/service.ts` (publish on open and change, pull on open, window focus, every ten minutes), `Repository.applyNotebook`, search indexing, `notebook.list` and `notebook.get`, trash list and Empty trash.
- Renderer: Notebook list on EntryPane (characters, places, chapters), page across the screen, Search hits, Trash group.
- Tests: `tests/unit/notebook.test.ts`, `tests/unit/pocket.test.ts`, `tests/integration/bridge.test.ts`, `tests/integration/migration15.test.ts`, `tests/e2e/notebook.spec.ts`; migration tests 9 to 14 now expect version 15. PROGRESS rows for A55, status pending.

## Full `npm test` (one run)
Lint, typecheck clean; unit 842/842; integration 340/340; e2e 278 passed, 3 failed, 54 not run: backstory "SM-9 a click on an empty spot...", plot "IP-3 each field in the popover...", tree "SM-1 the character page ..." (window 1200x770 not 800). Rerun of the three files alone (`--workers=1`): backstory SM-9 empty spot and tree SM-1 (window 1200x770) failed again; plot failed a different test (IP-3 first part divider) while the first IP-3 test passed, so plot looks flaky. Not yet compared with origin/main.

## Half done
- Run backstory.spec.ts line 586 and tree.spec.ts line 1055 on origin/main in a clean worktree to see whether they fail there too (both look like hidden-window geometry, but unproven).

## Not started
- Notebook list on the embedded row editor (Cultural data, Places tab; RowEditor/EmbeddedEditor). Today a place shows it only on its page opened from All sections or search.

## Decisions taken
- `notebookPages` is outside `entrySchemas` (manifest cannot make an entry collection read-only: IPC entry writes, Claude proposals, ED-1 and T-5 treat every entry collection as editable).
- World ID = bible ID with `_` as `-`; a clash leaves the bible unpublished.
- Decided questions in the pocket: those changed after the first publish (meta doc `bridge.since`).
- Trashed notebook pages have no Restore; they come back when the phone resends.
- Lines on a bible question with no page row make a thread named for the question.
- Chapters linked by title (case as written) or "chapter N".

## How to resume
`cd /Users/musicman/dev/nc-worlds-w3`; `npx playwright test tests/e2e/backstory.spec.ts tests/e2e/plot.spec.ts tests/e2e/tree.spec.ts --workers=1`; compare with main if needed. Then add `NotebookList` to `EmbeddedEditor` in `src/renderer/src/workspace/editor.tsx`.
