# W5 handoff: facts and questions from the notebook (A56), 2026-11-25

Branch `worlds-w5`, stacked on `worlds-w3` (draft PR #1). Draft PR against `worlds-w3`. Never push main; push with `NC_AUTO_INSTALL=0 git push origin worlds-w5`.

## Done
- Contract change (Tommy, 2026-11-25): the bridge lives once in `flowstate_bridge`. `Store.bridge` is a `BridgeDb` handle (connection.ts) reaching only bridge_worlds, bridge_down, bridge_up; `BridgeStore` takes it, never overwrites a non-novel registry row (`WorldTaken`), writes a pocket only for a novel world, reads only pages/messages/inquiries/songs. ARCH-8, NB-1 to NB-3, ARCHITECTURE.md amended. Tests: `tests/unit/single-database.test.ts`, `tests/integration/bridge-shared.test.ts`.
- FN-10 song stubs (kind `song`, title and characters only, caption "Song · in Music Companion", does not open, follows the phone, comes back when live again). Tests in `tests/integration/bridge-shared.test.ts` and `tests/unit/notebook.test.ts`.
- FN-7 questions: `src/shared/domain/phoneQuestions.ts` (pure), applied first in `BridgeService.pullOnce` (`applyQuestions`), event `notebook.questions` recorded by `undo.tsx`. Tests: `tests/unit/phone-questions.test.ts`, `tests/integration/phone-questions.test.ts` (both seen failing with the call removed).
- SPEC section 5.27 (FN-1 to FN-9), the A56 amendments row, SM-1 and SB-10 notes, the W5 milestone row; PROGRESS rows at `pending`.

## Half done
- Main side of the tray, Voice and Relevant built and tested (`tests/integration/tray.test.ts`): repository `trayMarks()`/`setTrayMarks()` (meta `notebookTray`), channels `notebook.offered`, `notebook.voice`, `notebook.relevant`, `tray.state`, `tray.mark` (write channel); pure `voiceRows`, `relevantRows`, `rowOf` in notebook.ts. Renderer begun: `captureNav.send` in capture.tsx (box sends a handed-over sentence in its own year with its chips; returns sent, busy or not sent), `openAsks` treats 'Year' as open, the Year chip shows empty and highlighted, `FactCard` takes `onDismiss`. Untested in e2e; tray.tsx not written.
- FN-1 to FN-5 pure model: `src/shared/domain/tray.ts`, typechecked, tested in `tests/unit/tray.test.ts` (7 tests). Not wired to a screen yet.

## Not started
- Tray renderer: screen `workspace/tray.tsx` reusing `FactCard`, `draftsWith`, `fileLocalDrafts` (File it command gets `run` ops that unmark/mark filed keys so undo re-offers); Dismiss as an undo step with `run` ops; App menu Manage item "From the notebook" (update the SM-6 e2e test in tests/e2e/year.spec.ts, APP_MENU_ITEMS); `captureLocal.openAsks` must treat 'Year' as open until `hint.startYear` is set, and `captureChips` must show the Year chip highlighted and empty when needed.
- FN-6: `captureNav.send({ text, year, hints, force })` in capture.tsx (store storyTime in Routed and use it in startRuns), mark the key `sent` only when a run starts; AI-6 Disclosure shown in the tray; Send off with no key or while the Year is needed.
- FN-8 renderer: `VoiceList` beside `NotebookList` in editor.tsx for characters.
- FN-9 renderer: the group on Relevant to Session calling `notebook.relevant`.
- ARCHITECTURE.md section for A56; PROGRESS rows evidence; whole `npm test` once.

## Decisions
- See the A56 row in SPEC.md: no status or source note; no provenance; no brief or tick; Voice read from the pages; paper lines not offered; a question taken back keeps its decision text.

## How to resume
Read SPEC 5.27, then this file's Not started list in order.
