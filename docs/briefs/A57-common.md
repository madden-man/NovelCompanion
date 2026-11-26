# A57 common brief: no instructions anywhere

Tommy, 2026-11-26: "remove all instructions everywhere. things should always work intuitively enough that i can just go in and use it." And on the start screen: "it should default to the bible last used, and allow you to go back to bible screen in options or something."

The design is `mockups/a57-no-instructions.html`: thirteen steps, each with the screen as it is (`.was`, every instruction wrapped in `<mark class="ins">`) and the screen as it should be (`.now`), plus a "How this is built" table naming the lines that go and what replaces them. Read your step(s) there first, then `docs/ARCHITECTURE.md` (binding), then the code and e2e tests you own. The published copy is https://claude.ai/artifact/3KrHKesRfVTpHg8rGNmfjD. Line numbers in the mockup are from `main` 4115daf.

## The rule

No screen carries text that tells the reader how to use it. That means: no intro paragraph under a heading, no hint line listing keys or gestures, no tooltip (`title`) that explains a gesture, no reassurance sentence ("nothing is saved until", "this is a flag only", "Cmd+Z brings it back"), no rule about what to type. Each one is replaced by something the screen shows:

- a gesture gets a visible handle, grip, ghost or "+" where it happens, and the right cursor;
- a key is shown as a `<kbd>` on the button or menu item it triggers (see the status bar's `Cmd K`), never in a sentence;
- a typing rule becomes a field that cannot take the wrong thing (digits only, derived values), so the error cannot occur;
- a consequence is said once, in the confirm for that action, at the moment of the press;
- an empty state says the thing is empty in a few words and stops;
- undo toasts carry an Undo button instead of naming the key.

What stays: labels, button names, placeholders that name the content (not the gesture), status and error messages for things that really went wrong, `aria-label`s (screen reader names may still name keys where there is no other way to learn them), confirms, and the "What Claude sends to Anthropic" notice (consent, shown once; `a57-claude` moves it). `Instructions for <feature>` in Settings are Claude's prompts, not user instructions; they stay.

Every keyboard path that exists today must still work. Removing the sentence that names a key never removes the key.

When you finish, your screens must contain none of the `<mark class="ins">` strings of your step, and you should grep your files for others the audit missed (sentences starting Click, Drag, Press, Type, Pick, Choose, Use, Leave, Enter; "to save", "undo step", "still saves") and treat them the same way.

## Packages

Nine builders, each in `.claude/worktrees/<branch>` on a branch off `a57-no-instructions`:

| Branch | Mockup step | Owns |
|---|---|---|
| `a57-open` | 2 `#open` | `src/renderer/src/App.tsx`, `src/main/connection.ts`, the `bible.*` handlers in `src/main/ipc/handlers.ts`, the bible name switcher in the app header, `tests/e2e/app.spec.ts` |
| `a57-add` | 3 `#add` | `workspace/capture.tsx`, `captureChips.tsx`, `captureLocal.ts`, `capture.css`, `tray.tsx`, `tests/e2e/capture.spec.ts`, `tray.spec.ts` |
| `a57-entries` | 4 `#entries`, 11 `#queue` | `workspace/Workspace.tsx` (the empty editor pane only), `views.tsx`, `editor.tsx`, `fields.tsx`, `editable/*`, `listSelect.tsx`, `listsScreen.tsx`, `review.tsx`, `search.tsx`, `words.tsx`, `pickers.tsx`, `undo.tsx` (toast with an Undo button, used by others through the existing notice API), `tests/e2e/editing.spec.ts`, `editable.spec.ts`, `knowledge.spec.ts` rows for these screens |
| `a57-tree` | 5 `#tree` | `workspace/tree/*`, `tests/e2e/tree.spec.ts` |
| `a57-outline` | 6 `#outline` | `workspace/outline/*`, `plot.tsx`, `tests/e2e/plot.spec.ts` |
| `a57-grids` | 7 `#world`, 9 `#time` | `workspace/timeline/*`, `workspace/backstory/*`, `storyTime.tsx`, `tests/e2e/timeline.spec.ts`, `backstory.spec.ts`, `year.spec.ts` |
| `a57-culture` | 8 `#culture` | `workspace/culture.tsx`, `culture.css`, `romanizationSystems.tsx`, `Zh.tsx`, the culture, places, romanization and glossary rows of `tests/e2e/knowledge.spec.ts` |
| `a57-check` | 10 `#check` | `workspace/sessions/*`, `claude.tsx`, `claude.css`, `notebook.tsx`, `tests/e2e/session.spec.ts`, `continuity.spec.ts`, `claude.spec.ts`, `notebook.spec.ts` |
| `a57-setup` | 12 `#backups`, 13 `#setup` | `workspace/backups.tsx`, `settings.tsx`, `settingsGroups.tsx`, `bibleSettings.ts`, `connection.tsx`, `housekeeping.*`, `docs/RUN-ON-ANOTHER-MAC.md`, `tests/e2e/backups.spec.ts`, `settings.spec.ts`, `offline.spec.ts` |

The mockup is a sketch of intent, not a pixel spec: build it from the app's existing components and CSS, keep what already works, and where the mockup and the real screen disagree on detail, do what Tommy's words ask.

## Rules that keep the merge clean

1. Touch only the files you own. A needed change in someone else's file (a shared type, one wiring line) is kept to the fewest lines, not reformatted around, and listed in your report with file and lines.
2. `app.css` and `theme.css` are shared: put new rules in a CSS file beside your component (as `capture.css`, `culture.css` do). You may delete `app.css` rules only your screens use. Use theme tokens only; both themes; NF-2 contrast and visible focus.
3. `tests/e2e/helpers.ts` and `tests/e2e/keyboard.spec.ts` are shared: change only the helpers or rows for your screens, fewest lines, listed in your report.
4. Tests: every e2e or unit test that asserts a removed string, tooltip or control changes to prove the replacement instead (the handle exists and works, the key on the button works, the field refuses the wrong input). Add one test per replaced instruction group, titled `A57 <what it proves>`. Never delete a test for behaviour that still exists. Use the fixture bible and the recorded Claude fake; never the real API.
5. Do not change `SPEC.md`, `PROGRESS.md`, `fixtures/expected/` or `docs/ARCHITECTURE.md`. Where a SPEC criterion quotes text or a control you removed, list the criterion ID and the new wording it needs in your report; the architect writes amendment A57.
6. Running things on this shared Mac: `npm run typecheck`, `npx eslint <your files>`, `npx prettier --check <your files>`, `npm run test:unit`, then only the e2e files you own, one at a time, with the RAM disk off: `npx electron-vite build && NC_TEST_RAM_DISK=0 npx playwright test tests/e2e/x.spec.ts`. Never `npm test`, never two Playwright runs at once in your worktree. Nine builders share the machine. If `mongod` dies with exit 137 or ECONNREFUSED, re-sign the cached binary (`codesign --force -s - ~/.cache/mongodb-binaries/mongod-*`) and run again; a start timeout under load is a rerun, not a failure.
7. Copy: plain words, active voice, never an em dash in any string or comment.
8. Git: commit on your own branch as you go, staging files by name (never `git add -A` or `git add .`). Do not merge, rebase, push, or touch another worktree or the main checkout. Do not kill processes you did not start.
9. Report at the end: what you built per instruction removed, the commands you ran with their last lines, the new and changed test names, lines changed in files you do not own, SPEC rows that need new wording, and anything not done with the reason.
