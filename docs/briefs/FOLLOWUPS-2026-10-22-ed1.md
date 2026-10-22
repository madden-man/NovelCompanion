# fu-ed1: make ED-1 pass again

Read `docs/briefs/FOLLOWUPS-2026-10-22-common.md` first.

`tests/e2e/editing.spec.ts` line 109, "ED-1 every field of every entity can be created and changed through the editor", has timed out on "Add to Strands" since aa85826 (2026-10-21 17:57), which is before A47. The A46 build made the Outline track a flat chapter list and A47 moved chapter strands into `ChapterStrands` (`src/renderer/src/workspace/outline/ChapterPage.tsx`, used by `editor.tsx`), and the strand chips popover now lives on the outline bars (IP-3). The test's `setField` (`tests/e2e/helpers.ts` from line 348) drives every field kind by its manifest spec, so the likely cause is that the chapter's strands field changed shape and the helper still looks for a control named "Add to Strands".

Steps:

1. Run the test alone to see the failure: `npx electron-vite build && npx playwright test tests/e2e/editing.spec.ts -g "ED-1 every field"`. Read the trace or the failing step, and `git log -p aa85826..main -- src/renderer/src/workspace/editor.tsx src/renderer/src/workspace/outline/ChapterPage.tsx tests/e2e/helpers.ts` to see what changed around strands.
2. Decide whether the test, the helper or the app is wrong. ED-1 is a spec criterion: every field of every entity can be created and changed through the editor. If a chapter's strands can no longer be changed from the chapter editor at all, that is an app bug under ED-1 and IP-1 and you fix the app (the fewest lines, in `ChapterPage.tsx` or `editor.tsx`). If the editor still offers it under a different control, fix the helper.
3. Make the row pass, then run the whole of `tests/e2e/editing.spec.ts` once, hidden, and `npm run test:unit`.
4. Do not weaken the test: it must still create every entity, set every editable field, and read every value back over IPC. If a field truly cannot be set through the editor by design, say so in your report with the criterion that says why, and skip it in the test with a comment naming that criterion.

Report: the cause in two sentences, the commands you ran with their last lines, the files and lines you changed, and whether the fix changed app behaviour.
