# Backstory screen: usability plan (2026-10-23)

Tommy, 2026-10-23, over the screenshots of the Backstory screen on Chapter 2 (story year 2051): the markers are too small to click, the grid is a strip under a paragraph of instructions, and the moments table is unreadable (seven columns, each one a field, so a column is eight characters wide and "Relevant world events" wraps one syllable per line).

Two changes, built in two waves (Tommy, 2026-10-23: "change 1 and 2 are good, but i don't want the person drawer"). Nothing changes in the data model, the write path, or undo (ED-3): every stored value stays an `Editable`, one write and one undo step per field (IP-1).

## What is wrong today

- `BackstoryView.tsx` stacks heading, zoom toolbar, a 110-word help paragraph, the grid, the legend, then the table. `.bs-scroll` caps the grid at `calc(100vh - chrome - 420px)`, so on a laptop it gets about 280px: three rows.
- Markers are 10px dots (`MARKER_DEFAULTS.dot`), bars 8px tall, lanes 22px, in rows of 36px. The hit area is the drawn dot. A miss lands on the empty track and makes a new blank moment (IP-4), which is the opposite of what the miss wanted.
- `MomentsTable.tsx` puts Year, To, Whose moment, Age, What happens, How they experience it, Relevant world events and Delete in one row. Two of those are rich text. The table cannot be narrower than about 1,300px and the editor column is about 700px.

## Change 1: the grid takes the section

Files: `backstory.css`, `BackstoryView.tsx`, `BackstoryGrid.tsx`, `src/shared/domain/backstoryGrid.ts`, `timeline/gridShared.tsx`, `timeline/grid.css`.

- **Delete the help paragraph** (`.bs-help`). The hints already live on the controls: the lifespan's `title`, the marker's `aria-label`, the `cursor: copy` on an addable track. Keep the legend, as one line at the foot, 0.8rem, so it costs 24px.
- **Zoom beside the heading.** Move the Zoom group into `.list-head` next to Story time and Change. The toolbar row goes.
- **Grid fills the rest.** `.bs-area` becomes `display: flex; flex-direction: column` with `overflow: hidden`; the grid frame gets `flex: 1 1 auto; min-height: 0` and `.bs-scroll` drops its `max-height`. The grid's own scroll (`.wg-scroll`) handles overflow. The legend and the trash notice sit under it with `flex: none`.
- **Bigger markers, taller rows.** New `BACKSTORY_MARKERS: MarkerOptions = { dot: 14, bigDot: 20, gap: 6, maxLanes: 4, labelWidth }` in `backstoryGrid.ts`, passed by `layoutBackstory`. `BACKSTORY_METRICS` becomes `{ header: 56, groupHeading: 32, lane: 28, rowPad: 10 }`, so a one-lane row is 48px (was 36px) and a two-lane row 76px. `GridMarker` in `gridShared.tsx` hard-codes bar heights (`m.big ? 12 : 8`); make them `opts.barHeight` and `opts.bigBarHeight` with the old values as the defaults, 10 and 14 for Backstory. The lifespan bar goes from 6px to 8px.
- **A hit area larger than the dot.** `.bs-marker::before { content: ''; position: absolute; inset: -6px; }` so a click within 6px of a dot lands on it, and the empty-track click (which makes a moment) only fires on a real gap. The label-width heuristic (`roughLabelWidth`) is unchanged, so labels show when they fit, as now.
- **World events grid is untouched.** It keeps `MARKER_DEFAULTS` and `GRID_METRICS`; the new options are Backstory's only.

Tests: `tests/unit/backstory-grid.test.ts` gets cases for the row heights and for `hitTest` on the new sizes. In `tests/e2e/backstory.spec.ts` the geometry tests ("the fixture families are headings...", "the fixture moments sit at their years...", "a marker drags along its row...") read positions from the layout, not from constants, so they should pass as they are; verify.

## Change 2: a moment opens in a dialog

New file `backstory/MomentDialog.tsx`; `MomentsTable.tsx` is deleted in wave 3.

A moment is edited in one place, a modal over the grid, using the app's existing `.dialog-backdrop` and `.dialog` styles (`app.css`) and `useFocusTrap`, the same way `StoryTimeDialog.tsx` does. Width `min(720px, 100%)`.

Layout, top to bottom:

1. **Head.** `{What happens or "Untitled moment"}`, then `{Name} {Chinese}, {year} to {endYear}, age {n}` in the secondary line. Right side: Previous and Next (the person's moments in year order, so a life reads through without closing), then Close.
2. **When and who**, one row of three fields: Year, To (blank for one year), Whose moment (select). Age is computed from the picked person and the year (TL-3) and shown beside Year, not a field.
3. **What happens**: a text `Editable`, full width, the field that opens first on a fresh moment (the `focusId`/`autoOpen` flow moves here).
4. **How they experience it**: a rich `Editable`, `mode="inline"`, `size="full"` (not `quick`), min-height 8 lines.
5. **Relevant world events**: the rich `Editable` with the mention chips, and the `EventPicker` under it, full width, so the picker list is not clipped by a cell.
6. **Foot**: Delete (`TrashControls`, same confirm, same undo notice in the view) on the left, Close on the right.

Behaviour:

- Opens from: a marker click or Enter on a marker (`onPickMoment`), and a fresh moment (empty-spot click or Add a moment). `selected` in `BackstoryView` already names the moment; the dialog is `selected !== null`. Closing clears `selected`; the marker keeps focus (the roving tab stop already tracks `ctl.active`).
- Escape closes. An open field saves on blur first (the queue in `BackstoryView.save` already orders it), so Escape in a field puts the stored value back and a second Escape closes.
- Every save is the existing `save(id, field, value, mentioned)`; the `undo.markSaved` check that looks for a `tr` with `data-id` becomes a check for the dialog's `data-id`.
- Previous and Next change `selected` only; the grid scrolls the new marker into view (`scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the selected marker, already present for the table row).
- A fresh moment closed with nothing typed stays as an empty moment, as today. (Optional, not in this plan: trash it on close as part of the create step.)
- Read-only snapshot (ARCH-6): every field is off with the reason, Delete off, Previous, Next and Close work.

Tests: e2e "a cell edit saves over IPC on Enter or blur", "Add a moment makes a row at the story year with focus on What happens", "a click on an empty spot...", "Delete lists what links...", "Pick events lists the events within the reach...", "a moment moves to another person through Whose moment", and "the screen works from the keyboard" move from table cells to the dialog. Add a helper `openMoment(page, id)` in `tests/e2e/helpers` that clicks the marker and returns the dialog locator. Add one test: "Previous and Next walk the person's moments by year without closing".

## What replaces the table

The table is deleted in wave 2. Nothing else lists moments: the grid is the list. A picked row is highlighted as now, and the head bar gains the creation controls the table carried:

- With a person picked: **Add a moment** (for them, at the story year; opens the dialog with What happens open). The name beside it reads `{Name} {Chinese}, {lifeYears}`.
- With nobody picked: **New moment**, which asks whose with the existing select (IP-13's "New moment asks whose it is" keeps its meaning).
- The "Every moment" table (IP-13) goes; the grid with every family open is that list. SPEC amendment A49 rewrites IP-13 and the table sentence of SM-9.
- The trash notice with Undo stays under the grid.

## Order of work

| Wave | Scope | Builder deliverable |
|---|---|---|
| 1 | Change 1 (grid fills, bigger markers, help gone) | `backstoryGrid.ts`, `gridShared.tsx` bar heights, CSS, unit tests, the geometry e2e tests green |
| 2 | Change 2 (MomentDialog), head-bar creation controls, delete `MomentsTable.tsx` | `MomentDialog.tsx`, `BackstoryView.tsx` wiring, e2e moved to the dialog |
| 3 | Spec and records | SPEC amendment A49 (SM-9 text, IP-13 wording), PROGRESS rows, ARCHITECTURE SM-9 line |

Each wave is one branch (`a49-grid`, `a49-dialog`) merged on green `npm test` with the e2e run hidden (`NOVEL_COMPANION_HIDDEN=1`, the default under test).
