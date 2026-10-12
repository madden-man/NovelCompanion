# M11 common brief: knowledge base shell (A34)

Read first, in this order: `SPEC.md` section 5.22 (KB-1 to KB-8) and amendment A34, `docs/ARCHITECTURE.md` (binding: the ten rules, the app shell notes, the builder workflow), then the code you will touch (listed in your own brief) and the e2e tests that cover it. Tommy's own words are in A34; where the criterion is silent, do what his words ask.

Four builders work in parallel on branches off `main` (b77019f or later), each in its own worktree under `.claude/worktrees/<branch>`:

| Branch | Criteria | Owns |
|---|---|---|
| `m11-shell` | KB-1, KB-2, KB-8 for its screens | `Workspace.tsx` (the rail and view switch), `TopBar.tsx`, `timeline/StoryTimeDialog.tsx`, `timeline/YearView.tsx`, `timeline/CompareView.tsx`, `tests/e2e/helpers.ts`, `tests/e2e/keyboard.spec.ts` (NF-2 rows for the rail, year view, compare, dialog), new `tests/e2e/year.spec.ts` |
| `m11-outline` | KB-3 | `plot.tsx` (may become `outline/*.tsx`), `src/shared/domain/outline.ts`, the `outline.*` and `plot.*` IPC and handlers, `tests/e2e/plot.spec.ts`, unit tests for the outline domain |
| `m11-world` | KB-4, KB-5 | `timeline/TimelineView.tsx`, new `entries/*.tsx`, `views.tsx` (`WorldEventsTimeline`), `culture.tsx`, `knowledge.tsx`, `tests/e2e/timeline.spec.ts` (chart rows), `tests/e2e/knowledge.spec.ts`, the NF-2 rows in `keyboard.spec.ts` for culture, places, romanization, glossary |
| `m11-capture` | KB-6, KB-7 | new `capture.tsx` and `capture.css`, new `src/main/claude/features/capture.ts`, `src/shared/claude.ts` (feature `capture`), `fixtures/claude/recordings.json` (append only), new `tests/e2e/capture.spec.ts`, unit and integration tests for the capture feature, the status bar Add button in `Workspace.tsx` (one line, see below) |

Rules that keep the merge clean:

1. Touch only the files you own. If you must change a file another builder owns (a shared type, a CSS token, one wiring line in `Workspace.tsx`), keep the change to the fewest lines, do not reformat around it, and list every such change in your report with the file and the lines. The architect re-applies them at integration.
2. `app.css` is shared: append your rules at the end under a comment with your branch name, never edit existing rules. Prefer a CSS file next to your component (as `claude.css`, `alignment.css` do).
3. The rail is being rewritten by `m11-shell`. If your screen needs a rail item that does not exist yet, add the smallest possible rail button and view kind in `Workspace.tsx` and note it; the shell builder's rail wins at integration and the architect re-wires your screen.
4. Removed rail items: e2e tests that used `rail(page, 'X')` for a removed item must reach the same content on its new screen. The shell builder changes `rail()` in `tests/e2e/helpers.ts` so that a button under the More disclosure is found after opening the disclosure; other builders can rely on `rail(page, 'Chapters')` and the like still working through More.
5. Tests prove criteria: test titles start with the criterion ID (`test('KB-5 the kind chips filter the list', ...)`). Reuse the existing fixture bible (`tests/helpers/loadFixture.ts`) and the recorded Claude fake (`fixtures/claude/recordings.json`); never call the real API in tests.
6. Running tests on this Mac: run `npm run typecheck`, `npx eslint src tests scripts`, `npx prettier --check src tests scripts`, `npm run test:unit`, and then only the integration and e2e files you touched, one file at a time (`npx vitest run --project integration tests/integration/x.test.ts`; `npx electron-vite build && npx playwright test tests/e2e/x.spec.ts`). Never run the full `npm test`, never run several Playwright or vitest suites at once: four builders share the machine and the full run brings it down. The architect runs the whole suite at integration. If `mongod` dies with exit 137 or ECONNREFUSED, re-sign the cached binary: `codesign --force -s - ~/.cache/mongodb-binaries/mongod-arm64-darwin-7.0.24` (the version may differ; look in that folder).
7. Copy standards (ARCHITECTURE rule 9): plain words, active voice, no em dashes in any string, labels never muted, both themes, keyboard reachable with visible focus, contrast per NF-2 (`tests/helpers/contrast.ts` is used by `tests/e2e/perf.spec.ts`).
8. Commit on your branch as you go with plain messages; do not merge, rebase or push. Do not touch `fixtures/expected/`. Do not change SPEC.md; if a criterion is wrong or impossible, stop and say so in your report.
9. Report at the end: the commands you ran with their last lines, a table of criterion to test names, the lines you changed in files you do not own, and anything not done with the reason.
