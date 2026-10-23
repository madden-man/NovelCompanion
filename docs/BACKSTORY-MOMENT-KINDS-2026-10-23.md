# Backstory moments: kinds and colours (2026-10-23)

Tommy, 2026-10-23: "make a plan to color code the event markers somehow, maybe when a character moves, that event shows as green, when significant life event happens, that's red. make a whole system, and make it work with the existing design, ensure color contrast is decent."

Companion to `BACKSTORY-PERSON-VIEW-2026-10-23.md`; same branch (`a50-person`) or the next one (`a51-kinds`). Mockup: the "Backstory person view" artifact, which draws the kinds and lets you recolour them.

## The system in one paragraph

A moment has a **kind**, picked from a list the writer owns (`momentKinds`, on the Lists screen like statuses and regions, IP-8 and IP-9). Each kind has a label, a colour and, optionally, a weight. The marker on the grid takes the kind's colour; a weighty kind draws its markers large (the `big` size the grid already has, so far unused by moments). Four kinds are seeded, all at the plain size (Tommy, 2026-10-23: the large red dots were too big); the writer adds, renames, recolours, reorders and reweights the rest. A moment with no kind draws as today, in the ink colour. Text never takes the kind's colour: titles, the tooltip and the legend stay in the text tokens, the swatch beside them carries the colour (NF-2, and the dataviz rule).

## The seeded kinds

| ID | Label | Colour, light | Colour, dark | Weight | Migration sorts into it |
|---|---|---|---|---|---|
| `move` | Moves | `#008300` green | `#008300` | | titles that start with "Lives in " |
| `life` | Life event | `#e34948` red | `#e66767` | | nothing (the writer marks these) |
| `work` | Work and study | `#4a3aa7` violet | `#9085e9` | | nothing |
| `voice` | Voice | none (drawn in `--fg-2`) | | | titles equal to "Voice" |

Why these colours: green and red are the two Tommy named. The third is violet rather than blue or aqua because blue is `--series-1` and aqua `--series-3`, the first two family colours, and the Hale lifespan bar is already blue; a kind should not read as a family. The three were run through the dataviz validator (`validate_palette.js`, all pairs, both surfaces):

- Light, surface `#fcfcfb`: every check passes; red against green sits in the CVD warn band (Delta E 7.2 protan), which the rules allow only with a second encoding. The second encoding is the text: the person view draws every title, the grid's tooltip and the dialog chip name the kind, and the legend keys both. Size is not used for it: Life event is seeded at the plain size; the weight stays on the Lists screen for a writer who wants a kind drawn large.
- Dark, surface `#1a1a19`: every check passes, no warning.
- A fourth colour was tried (blue `#2a78d6`, `#3987e5`): it fails against violet in dark mode (Delta E 1.9 protan, 9.8 normal). So the seed stops at three colours. A writer who adds a fifth kind picks their own colour; the Lists screen shows them whether it clears 3:1 on both chart surfaces (below).

Voice has no colour on purpose: the voice notes are many, one per chapter for some people, and in a colour they would drown the moments that mean something. They draw in `--fg-2`, one step quieter than a moment with no kind.

## Where the colour shows

1. **The grid and the person view.** `.bs-marker` takes `background: var(--bs-kind, var(--fg))`; the marker sets `--bs-kind` from the kind's colour. Bars across years take the same colour (today they are `--fg-2`). The 2px `--chart-surface` ring stays, so a marker reads on any family bar under it, including a green marker on the Zhou bar. A kind with `extra.weight = 'big'` sets `big` on the `GridItem`, which `placeRow` already turns into the larger dot and the taller bar; none of the seeded kinds is. The selected outline stays `--accent`.
2. **The legend** under the grid lists the kinds in the list's order, each as its swatch and label, after the lifespan keys and before the story year key. "No kind" is listed with the ink dot. The legend is the identity key the dataviz rules require for more than one series.
3. **The tooltip** adds the kind's label after the title: `2027 Lives in Portland, Oregon · Zhou Lian, age 39 · Moves`.
4. **The moment dialog** (A49) gains a **Kind** field in the When and who row, an `Editable` select over the list with Add new... (`onAddNew`, as Whose moment and the statuses do), and shows the kind as a chip beside the person in the head. Picking a kind saves it as one undo step.
5. **The Lists screen** gets the `momentKinds` list with the colour box (`ColourBox`), rename, reorder, remove when unused, and a **Weight** choice per item (plain or big) stored in `extra.weight`. Beside the colour box, a small readout: the contrast of the colour against both chart surfaces, with a plain note when either is under 3:1 ("Hard to see on the light grid"). The check is `contrastRatio` in `src/shared/domain/colour.ts`, new, the WCAG formula, with the two surfaces' hex values beside the tokens in `theme.css`.
6. **The character page** lists the person's moments; the kind swatch goes in front of each title there too.
7. **Capture and import** (`capture.ts`, `import/gridEntries.ts`) can set `kind` when the source makes it plain (a place lived is a move); otherwise they leave it null.

## Data

- `Moment` (`src/shared/schema/moment.ts`): `kind: z.string().nullable().default(null)`, and `momentFields` gains `f.listItem('kind', 'Kind', 'momentKinds')` so the write path refuses an ID the list does not hold (IP-9) and the unknown-list-item warning covers it.
- `LIST_IDS` gains `'momentKinds'`; `defaultLists.ts` seeds it for a new bible with the four items above (`color` as the light hex, no `extra.weight`).
- `THEME_HEX_TOKENS` (`lists.ts`) maps the three seeded hexes to new tokens `kind-move`, `kind-life`, `kind-work`, defined in `theme.css` for light and dark, so a seeded colour follows the theme as the family and status colours do. A colour the writer picks is drawn as its hex in both themes, as a family colour is.
- Migration 012 (`src/main/db/migrations/012-moment-kinds.ts`): writes the seeded list into every bible that lacks it, then sets `kind` on existing moments by title: "Lives in " prefix to `move`, exactly "Voice" to `voice`, everything else stays null. Idempotent, like 011.
- `backstoryGrid.ts`: `BackstoryMoment` carries `kind`; `momentItems` sets `big` when the kind's weight is big and the grid passes each marker its colour via `data` and the style variable. The grid takes the kinds list as a prop (`useList('momentKinds')` in `BackstoryView`).

## Contrast rules the build keeps

- Marker fill against `--chart-surface`: at least 3:1 in both themes for every seeded colour (computed with the WCAG formula: green 4.8 light and 3.5 dark, red 3.9 light and 5.4 dark, violet 8.3 light and 5.6 dark; Voice in `--fg-2` is 8.4 light and 9.7 dark).
- The ring between a marker and the family bar is 2px of `--chart-surface`, so fill against bar is never the thing that has to contrast.
- Labels, legend text, tooltip text, dialog chip text: `--fg` or `--fg-2`, never the kind colour.
- The legend swatch is 10px by 10px with a 1px `--border-strong` edge, so a light colour still has an edge on the light surface.
- Focus and selection stay the accent outline, which the kind colour never replaces.

## Tests

- Unit: `momentItems` sets `big` from the kind's weight; `kindColorCss` returns the token for a seeded hex and the hex otherwise; migration 012 sorts "Lives in" and "Voice" titles and leaves the rest null and runs twice without change; `contrastRatio` on the seeded hexes against both surfaces is at least 3.
- E2e: the dialog's Kind select saves as one step and the marker takes the colour (`getComputedStyle(marker).backgroundColor`); the legend lists the kinds in list order and renaming a kind on the Lists screen renames the legend key; a kind reweighted to big on the Lists screen draws the big marker; the Lists screen's contrast note appears for a colour under 3:1.

## Spec and records

- SPEC amendment A51 against SM-3 (a moment has a kind), SM-9 (markers in the kind's colour, the legend), IP-8 and IP-9 (`momentKinds` is a list with colour and weight), section 4 Moment fields.
- PROGRESS rows for SM-3, SM-9, IP-9.
- ARCHITECTURE: the `momentKinds` list, migration 012, `colour.ts`.

## Order of work

| Wave | Scope | Builder deliverable |
|---|---|---|
| 1 | Schema, list, tokens, migration, domain colour and weight | `moment.ts`, `lists.ts`, `defaultLists.ts`, `theme.css`, `012-moment-kinds.ts`, `colour.ts`, `backstoryGrid.ts`, unit tests green |
| 2 | Grid markers, legend, tooltip, dialog Kind field, character page swatch | `BackstoryGrid.tsx`, `BackstoryView.tsx`, `MomentDialog.tsx`, `backstory.css`, `character.tsx`, e2e green |
| 3 | Lists screen: the list with weight and the contrast readout; capture and import set `kind` where plain | `listsScreen.tsx`, `capture.ts`, `gridEntries.ts` |
| 4 | Spec and records | SPEC A51, PROGRESS rows, ARCHITECTURE |
