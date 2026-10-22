# fu-seed: seed the fixture's lists wherever the fixture is seeded

Read `docs/briefs/FOLLOWUPS-2026-10-22-common.md` first, then `tests/e2e/helpers.ts` lines 490 to the end (`seedFixtureLists`) and the two specs that call it (`timeline.spec.ts`, `backstory.spec.ts`).

Since A47 (IP-8, IP-9, IP-10), regions, statuses, provenance and age groups are list items, and an entry stores item IDs. A new test bible holds the default lists but not the fixture's own items, so a spec that seeds entries through `test.seed` and then reads a label on screen sees an item made from its ID (a region reads as its ID, not "Oregon") unless it calls `seedFixtureLists` first. Only `timeline.spec.ts` and `backstory.spec.ts` do. The other specs pass today either because they never read such a label or because they assert on the ID by accident.

What to build:

1. Find every `test.seed` call in `tests/e2e/*.spec.ts` (grep shows about twenty across capture, backstory, continuity, drive, keyboard, knowledge, claude, richtext, plot, session, timeline, year, tree). Leave `capture.spec.ts` and `editing.spec.ts` alone (other branches own them).
2. Make seeding the lists part of seeding the fixture, so no spec can forget it. The cleanest shape: one helper in `helpers.ts` (for example `seedFixture(invoke, ...)`) that calls `test.seed` and then `seedFixtureLists`, and every spec you own calls it instead of `test.seed` directly. If a spec seeds only part of the fixture or a hand-made entry set, keep its arguments and still seed the lists; the helper skips items the list already holds. Keep `seedFixtureLists` exported for the two specs that already call it, or move them over too.
3. Look for assertions that pass only because a label was an ID (an expectation on a region, status, provenance or age group string that matches a list item's `id` rather than its `label` in `fixtures/novel/*`). Fix each to the label and name it in your report.
4. Run every spec you changed, one file at a time, hidden, after `npx electron-vite build`. Each must stay green. If a row fails only because it now sees a label instead of an ID, fix the row; if it fails for another reason, say so and leave it.

Rules: change `helpers.ts` only from line 490 to the end (another branch owns `setField` above it); add your helper there. Do not change app code. No new behaviour, no new criteria: the tests are the deliverable.

Report: the helper's signature, the specs changed, the assertions corrected (file, line, before and after), and the last lines of every run.
