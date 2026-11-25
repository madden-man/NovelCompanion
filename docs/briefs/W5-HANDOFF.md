# W5 handoff: facts and questions from the notebook (A56), 2026-11-25

Branch `worlds-w5`, stacked on `worlds-w3` (draft PR #1). Draft PR against `worlds-w3`. Never push main; push with `NC_AUTO_INSTALL=0 git push origin worlds-w5`.

## Done
- SPEC section 5.27 (FN-1 to FN-9), the A56 amendments row, SM-1 and SB-10 notes, the W5 milestone row; PROGRESS rows at `pending`.

## Half done
- Nothing.

## Not started
- FN-7 questions (pure planner in `src/shared/domain/phoneQuestions.ts`, applied in `BridgeService.pullOnce`, event `notebook.questions` recorded by the renderer's undo).
- FN-1 to FN-6 the tray (pure `src/shared/domain/tray.ts`, meta `notebookTray`, channels `tray.state` and `tray.mark`, screen `workspace/tray.tsx`, App menu item, capture box `captureNav.send`).
- FN-8 Voice list, FN-9 Relevant to Session group.

## Decisions
- See the A56 row in SPEC.md: no status or source note; no provenance; no brief or tick; Voice read from the pages; paper lines not offered; a question taken back keeps its decision text.

## How to resume
Read SPEC 5.27, then this file's Not started list in order.
