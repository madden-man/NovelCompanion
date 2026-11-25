# W5 handoff: facts and questions from the notebook (A56), 2026-11-25

Branch `worlds-w5`, stacked on `worlds-w3` (draft PR #1). Draft PR against `worlds-w3`. Never push main; push with `NC_AUTO_INSTALL=0 git push origin worlds-w5`.

## Done
- FN-7 questions: `src/shared/domain/phoneQuestions.ts` (pure), applied first in `BridgeService.pullOnce` (`applyQuestions`), event `notebook.questions` recorded by `undo.tsx`. Tests: `tests/unit/phone-questions.test.ts`, `tests/integration/phone-questions.test.ts` (both seen failing with the call removed).
- SPEC section 5.27 (FN-1 to FN-9), the A56 amendments row, SM-1 and SB-10 notes, the W5 milestone row; PROGRESS rows at `pending`.

## Half done
- FN-1 to FN-5: `src/shared/domain/tray.ts` written (offeredPages, lineKey/factKey, trayGroups with the FN-2 Year ask, withMarks). UNTESTED, no unit test yet, not wired to anything. Typecheck not run on it.

## Not started
- Tray wiring: tests for tray.ts (tests/unit/tray.test.ts, FN-1 to FN-5); repository meta `notebookTray` with `trayState()`/`setTrayMarks()`; channels `notebook.offered`, `tray.state`, `tray.mark` (tray.mark is a write channel: add to WRITE_CHANNELS); screen `workspace/tray.tsx` reusing `FactCard`, `draftsWith`, `fileLocalDrafts` (File it command gets `run` ops that unmark/mark filed keys so undo re-offers); Dismiss as an undo step with `run` ops; App menu Manage item "From the notebook" (update the SM-6 e2e test in tests/e2e/year.spec.ts, APP_MENU_ITEMS); `captureLocal.openAsks` must treat 'Year' as open until `hint.startYear` is set, and `captureChips` must show the Year chip highlighted and empty when needed.
- FN-6: `captureNav.send({ text, year, hints, force })` in capture.tsx (store storyTime in Routed and use it in startRuns), mark the key `sent` only when a run starts; AI-6 Disclosure shown in the tray; Send off with no key or while the Year is needed.
- FN-8 Voice list (`notebook.voice`, pure `voiceRows` in notebook.ts, `VoiceList` beside `NotebookList` in editor.tsx for characters).
- FN-9 Relevant to Session group (`notebook.relevant` with cast, places incl. descendants via `placeAndDescendants`, strand year).
- ARCHITECTURE.md section for A56; PROGRESS rows evidence; whole `npm test` once.

## Decisions
- See the A56 row in SPEC.md: no status or source note; no provenance; no brief or tick; Voice read from the pages; paper lines not offered; a question taken back keeps its decision text.

## How to resume
Read SPEC 5.27, then this file's Not started list in order.
