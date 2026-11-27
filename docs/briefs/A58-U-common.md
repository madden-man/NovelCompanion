# A58 U packages: building a phone screen inside the U1 shell

Read `docs/briefs/A58-common.md` first (binding, including the Playwright machine rule), then `docs/briefs/A57-common.md` "The rule" (no instruction text), `docs/PLAN-PWA.md` section 3.10, SPEC.md section 5.28 (PH-29 to PH-37 and the criteria your prompt names), and look at the U1 screens in `docs/phone-screens/u1/`. Run the phone client and look at your screens before designing: `npm run web:local` serves the fixture novel at 127.0.0.1:8787 with key `local-phone-key` (pass `--port` if 8787 is taken by another builder; stop it when done).

Tommy uses this installed on an iPhone, one thumb. The desktop app must look and behave exactly as before, at any window width.

## The shell U1 built

- Phone check: `usePhone()` / `isPhone()` from `src/renderer/src/phone.ts`. Never use a width media query for phone behaviour.
- Navigation: `usePhoneNav()` from `workspace/phone/nav.tsx` gives `push(page)`, `back()`, `replaceTop(page)`, `switchTab(tab)`, `openSheet(name)`, `closeSheet()`, `reset()`, plus `tab`, `stack`, `top` and `sheet`. A page is `{kind:'entry'|'new'|'section'|'screen', ...}`, defined in `phone/places.ts` with the hash format. To add a screen, add its name to `Screen` and `SCREENS` in `places.ts` and a case in `ScreenView` in `PhoneFrame.tsx`; add it to `MORE` if it belongs in the bible menu. Opening an entry from any screen already pushes a page.
- Sheets: `<PhoneSheet name="..." label="..." title?>` from `phone/Sheet.tsx`. Add the name to the `Sheet` type first, then open it with `openSheet`.
- CSS: phone rules go in a `phone.css` beside your component, scoped under `:root[data-phone] .ph-frame`, theme tokens only, both themes. Variables: `--ph-top`, `--ph-bottom`, `--ph-target` (44px), `--ph-gutter-left`, `--ph-gutter-right`. Page content scrolls the whole document between the fixed bars, so drop inner scroll boxes. `.ph-frame .btn` is already 44 px tall. `kbd` is hidden. The contrast unit test checks your CSS too.
- Tests: `tests/web/`, WebKit iPhone 15 project; copy the setup of `phone-shell.spec.ts` (`webDb`, `seedFixtureNovel`, `startWebServer`, `openFixture`). Use `.tap()`, reach screens through `bible-menu-button` then `phone-more`, use `phone-back`, and title each test with its PH id. Pages you leave stay in the document hidden, so scope locators with `:visible` when a test id can repeat. Touch drags and pinches need real touch events: use a Chromium project with CDP `Input.dispatchTouchEvent` for those (add the project to `playwright.web.config.ts` if it is not there, with an iPhone-sized viewport and `hasTouch`), and WebKit for layout.

## Rules for every U package

- Shared files (`PhoneFrame.tsx`, `places.ts`, `Sheet.tsx`, `nav.tsx`, `playwright.web.config.ts`, `tests/web` helpers) are edited by several builders at once: add your lines, never reorder or reformat others'.
- Every control is a 44 px target; nothing is behind hover, right click or a key alone; every drag starts with a hold (hold-to-lift) so a scroll is never taken for a drag; inputs are 16 px or more; no instruction text; Undo stays the shell's button.
- Each screen you own gets tests for: no sideways page scroll, targets at least 44 px, nothing revealed only by hover, no instruction sentences, and the behaviour your criteria name. Run the Electron e2e file for each desktop screen whose component you touched, to prove the desk did not change.
- Run, one at a time: typecheck, `npx eslint .`, prettier on your files, `npm run test:unit`, `npm run build:web`, `npx electron-vite build`; then under the e2e lock with `--workers=1`: your web spec files, `tests/web/phone-shell.spec.ts`, and your Electron files. Hold the lock only while a run is going. Known base e2e failures, not yours: backstory "SM-9 empty spot", tree "SM-1 window size".
- Save a screenshot of each screen you built, light and dark, under `docs/phone-screens/<package>/` and commit them.
- Commit on your own branch as you go, staging by name; commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Report as the common brief asks, mapping each PH criterion to test names, and list every line you changed in shared files.
