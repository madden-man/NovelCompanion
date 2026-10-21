# A39 common brief: the simplified model and screens

Read first, in this order: `SPEC.md` section 5.23 (SM-1 to SM-12) and amendment A39 in the log at the end of section 10, `docs/DATA-AUDIT-2026-10-21.md` (the audit the decisions came from: what is stored today, why, and the target), `docs/ARCHITECTURE.md` (binding: the ten rules, schema versions, local development, builder workflow), then the code you will touch (listed in your own brief) and the tests that cover it. Tommy's own words are in A39; where a criterion is silent, do what his words ask. Do not open anything under `mockups/`; your brief describes the screen you build.

The work runs in two waves of three builders, each on a branch off `main` (2eb76f9 or later) in its own worktree under `.claude/worktrees/<branch>`. The worktree's `node_modules` is a symlink to the main checkout's; if a build or test fails in a way that smells of that, run `npm ci` in the worktree and say so in your report.

Wave 1 (now):

| Branch | Criteria | Owns |
|---|---|---|
| `a39-model` | SM-1, SM-2, SM-3, SM-4 and the engine side of SM-10 (`chapters.sceneNote`); migration 9; fixture novel | `src/shared/schema/*`, `src/main/db/migrations/*`, `src/main/db/session.ts` (the snapshot before migrating), `src/shared/domain/*` except `sceneOutline.ts`, `src/main/*` except `import/eastwinds.ts`, `src/shared/ipc*.ts`, `src/shared/claude.ts`, `character.tsx`, `editor.tsx`, `fields.tsx`, `views.tsx`, `knowledge.tsx`, `entries/*`, `outline/Arcs.tsx`, `outline/ChapterPage.tsx`, `outline/Strands.tsx`, `sessions/*`, `importProposals.tsx`, `fixtures/novel/*`, `fixtures/expected/*`, every unit and integration test, and the e2e specs other than `plot.spec.ts` and `timeline.spec.ts` |
| `a39-world` | SM-8 | `src/renderer/src/workspace/timeline/TimelineView.tsx` (becomes the grid, or is replaced by a new `timeline/WorldEventsGrid.tsx` and siblings), `timeline/*.css`, a new `src/shared/domain/worldGrid.ts` (pure layout and hit logic) with its unit test, `tests/e2e/timeline.spec.ts` |
| `a39-outline` | SM-5, SM-7 | `src/shared/domain/sceneOutline.ts`, `src/renderer/src/workspace/outline/Scenes.tsx`, `outline/OutlineView.tsx` (the Scenes and Year grid toggle and the year grid itself, which go; the arcs panel there is the model builder's), `outline/outline.css`, `outline/actions.ts`, the `sceneOutline.*` IPC schemas in `src/shared/ipc.ts` (fewest lines) and their handlers in `src/main/ipc/bibleHandlers.ts` (fewest lines), `tests/unit/scene-outline.test.ts`, `tests/integration/outline.test.ts` (the scene outline rows), `tests/e2e/plot.spec.ts` |

Wave 2 (after wave 1 merges): `a39-shell` (SM-6, SM-11, the screen side of SM-10: rail, Sessions, Continuity checker, Cultural data, Relevant to Session), `a39-backstory` (SM-9), `a39-importer` (IM-1 to moments and world events, A29).

The `moments` collection (SM-3), fixed here so every builder codes against the same shape. The model builder adds it to the schema in `src/shared/schema/moment.ts` and registers it in `entrySchemas`:

```ts
export const Moment = entry({
  characterId: Id,
  year: Year,
  /** Null for a single year. */
  endYear: Year.nullable().default(null),
  /** How the character experiences it. */
  body: z.string().default(''),
  /** Relevant world events, as text. */
  worldContext: z.string().default(''),
});
```

with `title` (the common field) holding what happens. Moments are entries: they carry status, provenance, source note, tags, links, revisions and the trash like every other entry (ARCHITECTURE rule 5). The collection name is `moments`, the kind label "Moment", the field labels "Year", "To", "What happens", "How they experience it", "Relevant world events". Chapters gain `sceneNote: z.string().default('')` ("What happens in this scene"), no migration needed.

Rules that keep the merge clean:

1. Touch only the files you own. If you must change a file another builder owns (a shared type, a CSS token, one wiring line), keep the change to the fewest lines, do not reformat around it, and list every such change in your report with the file and the lines. The architect re-applies them at integration.
2. `app.css` is shared: append your rules at the end under a comment with your branch name, never edit existing rules. Prefer a CSS file next to your component.
3. The rail is rewritten in wave 2. Do not rename or reorder rail buttons now; `rail(page, 'Timeline')` and `rail(page, 'Outline')` keep working. The model builder removes the rail buttons of dropped sections (facts, knowledge, themes, custom sections, arcs) in `Workspace.tsx` with the fewest lines and owns that file for wave 1.
4. Dropped data has tentacles. The model builder owns every removal of `facts`, `knowledgeRecords`, `themes`, `customSections`, `customEntries`, `arcs`, `relationships`, `plotBeats` and the character fields in SM-1, wherever they are, including renderer files in its list. The world and outline builders do not remove them; if their files still reference a dropped thing after wave 1, the architect reconciles at integration.
5. Tests prove criteria: titles start with the criterion ID (`test('SM-8 a marker drags along its row', ...)`). Reuse the fixture bible (`tests/helpers/loadFixture.ts`) and the recorded Claude fake (`fixtures/claude/recordings.json`); never call the real API in tests. Keep every existing test that still describes true behaviour; delete tests only for withdrawn criteria (SM-12) and say which in your report.
6. Running tests on this Mac: `npm run typecheck`, `npx eslint src tests scripts`, `npx prettier --check src tests scripts`, `npm run test:unit`, then only the integration and e2e files you touched, one file at a time (`npx vitest run --project integration tests/integration/x.test.ts`; `npx electron-vite build && npx playwright test tests/e2e/x.spec.ts`). Never run the full `npm test`, never run several Playwright or vitest suites at once: three builders share the machine and the full run brings it down. The architect runs the whole suite at integration. If `mongod` dies with exit 137 or ECONNREFUSED, re-sign the cached binary: `codesign --force -s - ~/.cache/mongodb-binaries/mongod-*` (look in that folder for the name). Every e2e run is hidden (`NOVEL_COMPANION_HIDDEN=1`, set by the helpers); never show the app window.
7. Copy standards (ARCHITECTURE rule 9): plain words, active voice, no em dashes in any string or comment, labels never muted, both themes, keyboard reachable with visible focus, contrast per NF-2.
8. Commit on your branch as you go with plain messages; do not merge, rebase, push or stash (`git stash` is forbidden on this machine). Do not change `SPEC.md`; if a criterion is wrong or impossible, stop and say so in your report.
9. Report at the end: the commands you ran with their last lines, a table of criterion to test names, the lines you changed in files you do not own, the tests you deleted and why, and anything not done with the reason.
