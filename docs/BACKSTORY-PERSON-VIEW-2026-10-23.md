# Backstory screen: one person's timeline (2026-10-23)

Tommy, 2026-10-23, after A49 landed: "when a character's row is clicked in the backstory section, the whole view should expand to show just that character's experience over the timeline, and each event should show its title without needing to hover. also, let's go back to the old design for each event, the new size looks a bit too big, but keep that design when the character's row is made fullscreen."

Three changes, one branch (`a50-person`). Nothing changes in the data model, the write path, or undo (ED-3). The moment dialog (A49) is untouched. Mockup: the "Backstory person view" artifact published with this plan.

## What is there today

- `BackstoryGrid.tsx` draws every family as a heading and every person as a row. A click on the name cell runs `onPick`: the row is highlighted, the head bar shows the name with Add a moment and Clear pick. Nothing else changes.
- Markers are the A49 sizes on every row: `BACKSTORY_MARKERS` (14px dot, 20px big dot, 6px gap, 10px and 14px bars) in `BACKSTORY_METRICS` rows (28px lanes, 10px pad, so 48px for one lane, 76px for two). Before A49 they were `MARKER_DEFAULTS` (10px dot, 16px big, 4px gap, 8px and 12px bars) in 22px lanes with 7px pad: 36px rows.
- A marker's title draws beside it only when the lane leaves room (`placeRow` in `worldGrid.ts`: `showLabel` when `labelWidth(label) <= labelRoom`). Otherwise the title is the hover tip and the `aria-label`.

## Change 1: the grid goes back to the old sizes

Files: `src/shared/domain/backstoryGrid.ts`, `backstory.css`, `tests/unit/backstory-grid.test.ts`, `tests/e2e/backstory.spec.ts`.

- `BACKSTORY_METRICS` returns to `{ ...GRID_METRICS, rowPad: 7 }` (22px lanes, 36px one-lane rows, 58px two-lane rows). `layoutBackstory` defaults to `MARKER_DEFAULTS` again.
- The A49 sizes are kept under new names, `PERSON_MARKERS` and `PERSON_METRICS`, for change 2.
- The lifespan bar and its legend key go back to 6px.
- The invisible hit area stays (`.bs-marker::before`, 6px past the dot): it is what makes a near miss open the moment instead of adding one (IP-4), and it does not change the look.
- The unit test "rows are 48px for one lane and 76px for two; markers are 14px dots" and the e2e "a marker is a 14px dot in a 48px row" assert 36px, 58px and 10px for the grid; the 14px and 48px assertions move to the person view.

## Change 2: a row click opens the person's timeline

Files: `BackstoryView.tsx`, `BackstoryGrid.tsx`, `MomentCreate.tsx`, `backstory.css`, `src/shared/domain/backstoryGrid.ts`, `src/shared/domain/worldGrid.ts`, `timeline/gridShared.tsx`.

**State.** `BackstoryView` gains `person: string | null` beside `picked`. A click or Enter on the name cell (`.bs-row-label`) sets both. The grid gets a `personId` prop; when it is set, the grid draws that one person and nothing else. The name link in the cell still opens the character page (IP-4); it does not open the timeline.

**What the person view draws.** The same `GridFrame`, `GridHeader` (years and the era band), `GridOverlay` (story year line, writing band) and `GridTip`. Under the header, one row:

- The label cell: the family swatch, the name, the Chinese name, and the life years on a second line (`lifeYears`). The cell is the same button; a click on it leaves the view (the row is a toggle).
- The track fills the rest of the frame's height. `useGridViewport` measures the frame's height as it measures its width (`viewHeight`, a second `ResizeObserver` reading in `GridFrame`); `layoutPerson(grid, personId, scale, minHeight)` in `backstoryGrid.ts` makes the one row `max(lanes * lane + 2 * rowPad, minHeight)` tall, where `minHeight` is `viewHeight - header`. The lifespan bar sits at the foot as now; the lanes start at the top.
- Markers at the `PERSON_MARKERS` sizes in `PERSON_METRICS` lanes (14px dots, 28px lanes). Every marker draws its title. `placeRow` gets a new option, `reserveLabel: boolean` (false by default, so World events and the grid are unchanged): when set, a lane's end is `x + width + gap + labelWidth(label)`, so the next marker in the lane starts past the title, and `showLabel` is true for every marker. `maxLanes` is 8 in `PERSON_MARKERS`; past that, lanes share as they do now. `labelWidth` for the person view is `min(roughLabelWidth(label), 240)`, and `.bs-person .wg-mlabel` is `max-width: 240px` with an ellipsis, so a long title cannot push a lane across the track.
- The hover tip stays (it carries the years and the age, which the label does not).
- Everything a row does today still works: a click on an empty spot adds a moment for the person at that year and opens it, a marker click or Enter opens the dialog, double-click opens it with What happens open, F2 renames, drags and arrow keys move the marker, the lifespan's ends drag.

**Leaving.** Three ways back to everyone, all to `setPerson(null)` with `picked` kept:

- Show everyone in the head bar (`MomentCreate`'s Clear pick becomes two buttons: Show everyone when a person view is open, and the existing Clear pick is folded into it; with the view closed the picked name shows as now with Add a moment and Clear pick).
- Escape, when no dialog and no field is open (the dialog's own Escape runs first because it is a focus trap; the grid listens on the frame).
- A click or Enter on the name cell.

On return the grid scrolls the person's row into view (`scrollIntoView({ block: 'nearest' })` on `.bs-row[data-person]`, as the dialog does for a marker) and focus goes back to their name cell.

**Opening from elsewhere.** Their backstory on a character page (SM-10, the `characterId` prop) opens the person view on them, every time it is asked (the `openedAt` flow sets `person` as well as `picked`).

**What a marker click does not do.** Today a marker click picks its person (row highlight, name in the head bar). It keeps doing that and does not open the person view; only the name cell does. Otherwise a click on a marker in the grid would swap the whole screen under the dialog it just opened.

**Read-only snapshot (ARCH-6).** The person view opens and closes as usual; every write inside it is off with the reason, as in the grid.

**Not in this plan.** The browser's own fullscreen (the family tree's `requestFullscreen`) is not used: "fullscreen" here means the section. The age under each title in the person view (a second line per label, 40px lanes) was considered and left out; say the word and it is a small addition.

## Change 3: the spec and the records

- SPEC amendment A50 against SM-9, SM-10, IP-4: the row click opens one person's timeline with every title shown; the grid's markers are 10px in 36px rows and the person view's are 14px in 48px lanes; the hit area sentence stays.
- PROGRESS rows for SM-9 (person view), IP-4 (sizes), SM-10 (opens on the person).
- ARCHITECTURE's SM-9 line gains `layoutPerson` and `reserveLabel`.

## Tests

Unit (`tests/unit/backstory-grid.test.ts`, `tests/unit/world-grid.test.ts`):

- The grid: 36px and 58px rows, 10px dots, 8px bars; `MARKER_DEFAULTS` unchanged.
- `placeRow` with `reserveLabel`: two moments a year apart take two lanes when the first title does not fit before the second; every marker has `showLabel` true; a title longer than 240px reserves 240px.
- `layoutPerson`: one row, height `max(lanes * 28 + 20, minHeight)`, markers at 14px, the lifespan from the person's years, no group line.

E2e (`tests/e2e/backstory.spec.ts`):

- "picking a person highlights the row and shows their name and Add a moment in the head" becomes "a click on a name opens that person's timeline: only their row, every title drawn, the name and Add a moment and Show everyone in the head; Show everyone, Escape and the name cell each return to the grid with the row in view and the name focused".
- "a marker is a 14px dot in a 48px row" becomes two: 10px in 36px on the grid, 14px in a row at least 48px tall in the person view, the near-miss click in both.
- "Backstory opens on a person given to it" asserts the person view is open on them.
- "the screen works from the keyboard" adds Enter on the name cell and Escape back.
- "a click on an empty spot in a row adds a moment" runs once more inside the person view.
- The rest keep passing as they are: they click markers, not name cells.

## Order of work

| Wave | Scope | Builder deliverable |
|---|---|---|
| 1 | Change 1 and the domain half of change 2 (`reserveLabel`, `layoutPerson`, `PERSON_*`, `viewHeight`) | `worldGrid.ts`, `backstoryGrid.ts`, `gridShared.tsx` viewport, unit tests green |
| 2 | The view: `personId` on the grid, the one-row render, head bar buttons, Escape, SM-10 opening | `BackstoryGrid.tsx`, `BackstoryView.tsx`, `MomentCreate.tsx`, `backstory.css`, e2e green |
| 3 | Spec and records | SPEC A50, PROGRESS rows, ARCHITECTURE line |

One branch, `a50-person`, merged on green `npm test` with the e2e run hidden (`NOVEL_COMPANION_HIDDEN=1`, the default under test).
