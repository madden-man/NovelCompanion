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
