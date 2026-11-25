# W5 handoff: facts and questions from the notebook (A56), 2026-11-25

Branch `worlds-w5`, stacked on `worlds-w3` (draft PR #1). Draft PR #2 against `worlds-w3`. Never push main; push with `NC_AUTO_INSTALL=0 git push origin worlds-w5`.

## Done
- SPEC section 5.27 (FN-1 to FN-10), the A56 row, ARCH-8 and NB-1 to NB-3 amended for `flowstate_bridge`, SM-1 and SB-10 notes, the W5 milestone row. PROGRESS rows at `pending` with evidence.
- FN-7 questions from the phone (`phoneQuestions.ts`, `BridgeService.applyQuestions`, event `notebook.questions`, `undo.tsx`).
- FN-1 to FN-6 the tray (`tray.ts`, meta `notebookTray`, channels, `workspace/tray.tsx`, App menu item, `captureNav.send`, Year chip).
- FN-8 Voice, FN-9 Relevant to Session group, FN-10 song stubs.
- The shared bridge database `flowstate_bridge` through the `BridgeDb` handle (Tommy, 2026-11-25), with the reach and Songbook tests.
- ARCHITECTURE.md: "The phone bridge" updated and a new A56 section.
- Tests: unit `phone-questions`, `tray`, `single-database`, `notebook`; integration `phone-questions`, `tray`, `bridge-shared`, `bridge`; e2e `tray.spec.ts` (9), `year.spec.ts` updated for the menu item.

## Half done
- The whole `npm test` run (see PR body for the numbers once run).

## Not started
- Nothing in scope.

## Decisions (Tommy has not ruled on the starred ones)
- File it writes plain new entries; no status, no source note (Tommy, 2026-11-25).
- * Voice is read from the in-story councils' pages, not stored, not moments.
- * A paper's or another voice's line is not offered; a character's line in a council about the story is.
- * A question taken back on the phone keeps its decision text (state Open).
- * The tray is an App menu item, "From the notebook", after Review queue.
- * Send to Claude hands the single sentence to the capture box, with the page's year and the card's chips; the proposals are filed in the box.
- * A Send needs the year picked first when the tray would otherwise guess it.
- * A fact is marked filed only when every draft of it filed; Dismiss and File it are undo steps (undo offers the fact again).
- * A question asked on the phone keeps the phone's ID as its entry ID.
- * Steps from a pull before the window listens (the first pull on open) have no undo step.
- A song stub links only the characters the phone gave it, never names found in its title.

## How to resume
Run `npm test`; the two known e2e failures are `backstory.spec.ts` SM-9 empty spot and `tree.spec.ts` SM-1 the character page.
