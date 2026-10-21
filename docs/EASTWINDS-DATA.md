# East Winds bible: data work log

What has been done to the real `eastwinds` bible in Atlas outside the app's own screens, and why. Each step began with a manual snapshot (Backups can restore it) and was rehearsed on a local copy first.

## 2026-10-11: source audit and structure

Snapshot "Before the East Winds audit" (2026-10-11T20:43:52.209Z). Three read-only extraction agents compared the bible with the Drive folder; the results were written through `Repository`.

- **People and the family tree.** 32 characters (13 existing ones given full names, Chinese names where the sources give them, births, deaths, birthplaces, voice notes, places lived; 19 added), 3 families (Sullivan, 李, Shaw), 10 unions, 32 parent links, 23 relationships. Existing backstory prose from the Life documents was kept; summaries went to the body. Five unnamed placeholder people (tag `unnamed`) exist only so the tree can draw their links.
- **World.** 41 nested places, 16 cultural entries (8 communities added to the list), 27 glossary terms, 32 facts, 26 knowledge records, 16 themes, 35 arcs (all 129 beats ordered in their family arcs).
- **Links.** Beats attached to chapters and to the characters they name, chapter strands given characters present, 171 world events given characters affected and regions. HaoYu's death beat got year 2093 and POV; the mission trip moved to 2043 (newer edit).
- **Open questions.** 43, tagged `Audit 2026-10-11`, for contradictions between sources.
- Not done: era prose split into the era topic fields, missing world events, formative flags, deleting the seeded decade eras.

## 2026-10-11: chapter plan (A29)

Snapshot "Before the High Level chapter plan" (2026-10-11T21:37:08.162Z).

- Book One's 48 High Level chapters created (present strand primary, backstory strand labelled "Backstory: ..."), linked to their arcs; the second "Ch. 8" is "Ch. 9: HaoYu and Family Break".
- Book One's 50 Plot v1 rows moved to the trash; five rows with no matching beat became beats; their beats are unattached to a chapter but stay in their arcs; 24 theme appearances guessed from those rows' titles were removed.
- Manuscript chapter 1 is on "Ch. 1: Mark Feels Free" (open question: or Ch. 2, "Mark Meets Dawn").
- The Introduction is 2078. Book Two keeps its Plot v1 chapters.
- Reading order renumbered 1 to 99.

## 2026-10-11: title cleanup (PL-3)

Snapshot "Before the title cleanup 2026-10-11" (2026-10-12T02:47:32.936Z). `scripts/clean-titles-eastwinds.ts` was rehearsed on a local copy, then applied through `Repository.writeBatch`, with a revision note on each write.

- 55 titles lost a structural number that repeated their number field or place: 46 chapters ("Ch. 3: Mark Gets Drunk" is now "Mark Gets Drunk"), 8 parts ("Part One: Sins of the Father" is now "Sins of the Father"), 1 book ("Book Two: I Take Refuge in You" is now "I Take Refuge in You"). The app shows "Chapter N" from reading order and "Part N" / "Book N" from the number fields.
- Every chapter number matched the chapter's place in its part (the Introduction not counted), so no open question was needed.
- Left alone: "Book One" (only a number, no name to keep); the two chapters Tommy had already renamed and reordered ("Mark Meets Dawn", "Mark Feels Free"); open question titles that quote the source sheet's "Ch. N" names; primary strand labels such as "Mark: College Arc" (the A29 arc span names).
- The write path also filled two missing schema defaults on the 46 chapters (`summaryOutOfDate: false`, `manuscriptSource: null`); nothing else changed.

## 2026-10-21: the importer follows A39 (not yet run on the real bible)

Branch `a39-importer`. Nothing was written to Atlas; the re-import is the architect's to run with Tommy. `npm run import:eastwinds` is now a dry run unless given `--yes`, which takes a snapshot first. The report ends with entries made or changed per section (chapters, world events, moments, characters, then any other).

What the default mapping does with `East_Winds_World.xlsx` now:

- **High Level, rows above "Characters"** become Book One's chapters (A29): a "Part ..." row starts a part of "Book One", and each chapter row's strand labels, read across the year columns, become a present (primary) strand and a backstory strand with their start and end years. A label starting "Backstory:" is the backstory strand. When neither label says so (Part Four: "Siyuan: ..." and "Forestory: ..."), the later span is the present and the earlier one is labelled "Backstory: <label>". Titles lose their "Ch. N:" (the second "Ch. 8" is "HaoYu and Family Break", and the report notes it). A chapter is matched by its part's title and its own title, among all chapters, so the 48 chapters made by hand on 2026-10-11 are updated, not duplicated. The strand's point of view, characters and places are kept; only label and years come from the sheet.
- **High Level, the Characters block** (four filled cells: Frank, Mark, Qin, Dawn) becomes moments of the person the row names. These were skipped before.
- **High Level, from "Foundational Drivers" down** stays world events under group and subcategory, matched by category and year as before. Regions are read from the row label (US, China, Europe, India, Japan, Russia, Mexico, Taiwan, Africa) and only added: a region set by hand stays.
- **Sullivan and 李** become moments (one per row). The character is found by the full name, a word of it ("Qin" is Li Qin), or the Chinese given name (勤 is 李勤); when two people share the name, the sheet's family decides. Moments made from plot beats by migration 9 keep their IDs and their import records (the beat's `povCharacterId` and `experienceNote` records now speak for `characterId` and `body`), so a body edited since is not reverted and a changed year updates the moment in place.
- **Plot v1**: Book One's rows are left out and reported (High Level plans that book); Book Two's rows stay chapters, read after every chapter already planned.
- **The Introduction**, when the import has to make it, is set in 2078.
- Claude's import proposals (IM-5) name characters, moments, world events and open questions only.

Rehearsal on a fresh local bible (local replica set, 2026-10-21), from `source-material/`:

- Dry run: High Level chapters 53 new (1 book, 4 parts, 48 chapters), High Level moments 8 (4 moments, 4 people), world events 226, Sullivan 105 (96 moments, 9 people), 李 36 (32 moments, 4 people), Plot v1 64 (Book Two: 1 book, 4 parts, 50 chapters, 9 people; Book One's 55 rows left out). A dry run cannot see what earlier steps would make, so on an empty bible it counts a person once per sheet that names them.
- Applied with `--yes`: chapters 99 new (48, 50, the Introduction), world events 226, moments 132, characters 13 new and 3 given backstories, books 2, parts 8, era states 9, open questions 2. One row failed: Sullivan row 98, "HaoYu is killed by a Chinese drone", has no POV and no year ("There is no value for Character"); the real bible's moment for it (year 2093 and point of view set by hand on 2026-10-11) is left alone.
- A second run reported created 0, updated 0, unchanged 482, failed 1 (the same row).

To check before applying on the real bible: the strand changes the dry run lists for the 48 hand-made chapters (labels and years the 2026-10-11 work may have set differently, Part Four especially), and any moment the run would create because its title differs from the beat it was made from.
