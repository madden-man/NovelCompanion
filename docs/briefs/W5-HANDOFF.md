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

## Review fixes (after the review of 728c349)
1. A question held once (given to the phone, made from it, deleted forever) never comes back: `meta.bridge.questionIds`, carried over a restore.
2. Question steps wait in `BridgeService.claimSteps()`; `UndoProvider` claims on mount and per event for its own bible (`notebook.claimSteps`).
3. File it records its undo step before the mark (`trayFile.ts`).
4. A desk edit mid-pull stands (`expectModifiedAt`, `EntryMoved`).
5. A wise line edited on the phone counts as a change.
6. Kept lines group by local day (`localDay`).
7. A sent card comes back if its run fails or stops, or the box closes unfiled (`onUnfiled`).
8. Test gaps closed (see PROGRESS).

## Suite after the review fixes (055a161)
`npm test`, under a load average near 9: lint and typecheck clean; unit 870/870; integration 362/362; e2e 241 passed, 6 failed, 102 not run. Two are the known ones. The other five listed (backstory TL-3, editable IP-1, editing ED-1, plot A46, year IP-5) passed when their files were run again with one worker. A second whole e2e run: 287 passed, 4 failed (the two known ones, richtext A44, flaky on the base, and plot IP-3, which passed when plot.spec ran alone, 35/35), 58 not run.

## Half done
- Nothing. Last full `npm test` (before the FN-6 test fix): lint and typecheck clean; unit 865/865 (71 files); integration 357/357 (34 files); e2e 299 passed, 4 failed, 44 not run. The failures were the two known ones, `tray.spec.ts` FN-8 (the FN-6 test left the capture box open; fixed in f9381d9, tray and year specs then 25/25) and `year.spec.ts` IP-5 (passed on rerun). A second whole e2e run after the fix: 302 passed, 3 failed (the two known, plus `richtext.spec.ts` A44 typing shortcuts, which passes and fails intermittently when run alone on this branch; W5 touches no rich text or culture file), 42 not run.

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
