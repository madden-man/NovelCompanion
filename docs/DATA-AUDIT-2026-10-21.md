# Data model and screen audit, 2026-10-21

Tommy's brief, 2026-10-21: "the data structure is far too complicated." A character should be
name, Chinese name where applicable, short description, description, backstory where applicable.
Family relationships live in the family tree. The Outline is two connected panels: scenes with
their years on the left, draggable vertical chapter bars on the right. World events are a grid,
years left to right, many rows of markers like the original world tracker sheet. Everything about a
character is editable with little clutter. The rail he cares about (sketch IMG_6993): Characters,
Family Tree, Outline, World Events, Backstory, Continuity Checker, Sessions, Cultural Data, under a
top bar with the story year, the chapter being written, Relevant, and Start session.

This audit counts what is stored in the East Winds bible today (read-only report, 2026-10-21),
says what every collection and field is for, and proposes the target model and screens. Nothing
here is applied yet. The decisions it needs are at the end.

## 1. What is stored today

23 collections. Live counts in East Winds, then the fields, with how many entries fill each one.

| Collection | Live | Fields of its own (filled count) | Common fields filled |
|---|---|---|---|
| characters | 32 | names.full 32, names.chinese 8, names.romanization 8, names.order, names.birthName 1, names.marriedName 0, names.nicknames 1, names.calledBy 1, birth 32, death 5, birthplace 6, familyIds 25, backstory 32, voiceNotes 9, placesLived 21, backstoryMarks 0, role 0 (new today) | body 3, tags 28, sourceNote 8, provenance 32, sourceRef 32 |
| families | 3 | name, color, notes 0 | |
| unions | 10 | partnerIds, type, startYear 6, endYear 3, endReason 5 | body 10 |
| parentLinks | 32 | parentId, childId, type, startYear 3 | |
| relationships | 23 | characterIds, type (friend, rival...), startYear 20, endYear 8 | body 23 |
| books | 2 | number, summary | |
| parts | 8 | bookId, number, summary | |
| arcs | 35 | name, scope, familyId 1, ownerCharacterId 29, startYear, endYear, summary 35 | sourceNote 13, tags 16 |
| chapters | 98 | partId, readingOrder, strands (label, years, pov, cast, places), arcIds 47, factsInPlay 0, written, manuscriptText 2, summary 48, summaryOutOfDate, sourceFile 2, manuscriptSource 0 | body 50, sourceNote 47 |
| plotBeats | 134 | arcIds, arcOrders, chapterId 49, year 134, povCharacterId 134, description 0, worldContext 133, experienceNote 128 | tags 134, links 74 |
| worldEvents | 226 | start, end 0, reality, categoryId (111 of 126 categories used), regions 153, placeIds 0, characterIds 51, formative | body 61 |
| eraStates | 17 | name, startYear, endYear, technology 0, climate 0, economy 0, politics 0, dailyLife 0 | body 9 |
| culturalEntries | 16 | communityId, startYear, endYear, generationNotes 9 | body 16 |
| places | 41 | parentId 31, communityId 18, descriptions 41 | body 11 |
| glossaryTerms | 27 | characters, romanization 14, language, meaning, usageNote 20 | |
| facts | 32 | (title and body only) | tags 32 |
| knowledgeRecords | 26 | factId, characterId, yearLearned 23, chapterLearnedId 1, how 26 | |
| themes | 16 | description, appearances 13 | |
| openQuestions | 94 | question, state, decision 6 | links 85, sourceNote 45, tags 94 |
| sessionLogs | 0 | date, chapterId, stoppedAt, notes, partId, strandId, storyYear, povCharacterId, briefId | |
| briefs | 0 | chapterId, storyYear, pov, entryIds, content, sectionKind, strandId, partId, placeIds, characterIds, added, removed, model, synthesized, selection | |
| findings | 2 | chapterId, kind, text, quote, lines, entryIds, state, resolutionNote, key, check, strandId, storyYear, mustChange, changeSet, rejectedChanges, dismissal, runId | |
| customSections | 1 | fields | |
| customEntries | 2 | sectionId, values | |

Every entry also carries the common fields: title, body, status (canon, planned, idea),
provenance (researched, invented), sourceNote, sourceRef, tags, links, createdAt, modifiedAt,
deletedAt. Plus the `meta` document for the scene outline (text, breaks, ranges) and its versions,
and 10 editable lists (union types, parent link types, communities, statuses, provenance,
126 event categories in 15 groups, romanization systems, languages, tags, era defaults).

Where the clutter comes from:

- **Every entry shows every common field.** Provenance, source note, source location, tags and
  links appear on all 23 kinds. They were built for the importer (`sourceRef` is set on 32 of 32
  characters by the import) and for search filters (SR-2). By hand they are rarely used: 3
  characters have a body, 8 a source note.
- **Characters carry seven name parts and four lists.** Romanization 8, birth name 1, married name
  0, nicknames 1, what others call them 1. Voice notes 9, places lived 21 (from the import), backstory
  marks 0. Each is a list editor on the page.
- **The family is modelled four ways.** Families, unions, parent links, and relationships
  (friend, rival, employer, 23 of them from the import, shown nowhere but the manuscript tool and
  the importer's proposals).
- **The story is modelled five ways.** Books, parts, chapters with strands, arcs, plot beats, plus
  the scene outline text. Beats (134) are the Sullivan and Li sheets: one dated moment per
  character with "relevant world events" and "how the POV character experiences this". Arcs (35)
  are the year spans per character from the High Level sheet. Strands (2 per chapter) carry the
  present and backstory years of each chapter.
- **The world is modelled five ways.** World events (226 under 126 categories), era states (17,
  with five prose fields nobody filled), cultural entries (16), places (41, with dated
  descriptions), glossary (27).
- **Knowledge is its own system.** Facts (32), knowledge records (who learned what when, 26),
  themes (16), open questions (94, most made by the importer and the capture box).

## 2. Target model

The rule: a thing is stored once, in the place the writer thinks of it, with the fields the
writer fills by hand. Fields that an engine needs (status for the chips, provenance for the
importer, the IDs that link things) stay stored but leave the page. Fields nobody fills go.

### Character

| Keep | Why |
|---|---|
| name (`names.full`) | |
| Chinese name (`names.chinese`) | GL-3 hover meanings. |
| short description (`role`, "In the story") | new today |
| description (`body`) | |
| backstory (`backstory`) | 32 of 32 filled |
| birth, death | the tree and every age need them; shown as two small date fields under the name |
| families (`familyIds`) | the tree's colours and the family filter |
| status | the canon, planned, idea chip; one small control |

| Drop from characters | Filled | What takes it over |
|---|---|---|
| names.romanization, order, birthName, marriedName, nicknames, calledBy | 8, 32 (default), 1, 0, 1, 1 | Romanization moves to the glossary term for the name when it matters. The rest is prose in the description. |
| birthplace | 6 | first line of places lived was the same thing; becomes prose, or the first Backstory row |
| voiceNotes | 9 | become dated Backstory rows (section 3) with a "voice" tag; the brief keeps reading them from there |
| placesLived | 21 | become dated Backstory rows ("Moves to San Francisco", 2030 to 2041); the cultural-context engine (A35) reads places from those rows instead |
| backstoryMarks | 0 | gone; the Backstory rows carry their own years and pins |
| tags, sourceNote, sourceRef, provenance, links | 28, 8, 32, 32, 0 | stored, set by the importer and the capture box, not shown on the character page |

### Family

Keep families (name, colour), unions, parent links. Drop **relationships** (23): nothing on screen
reads them; the friend, rival and employer notes move into the two characters' descriptions by a
one-off script that appends "Friend of X from 2031" lines, reviewed before it runs.

### Story

| Collection | Proposal |
|---|---|
| books, parts | keep; only a number and a title are edited, from the Outline's headings |
| chapters | keep `title`, `partId`, `readingOrder`, `written`, `summary`, `manuscriptText`; keep strands but edit only the primary year and POV in the Outline; `factsInPlay` (0 used) and `arcIds` go |
| arcs | drop (35). They were year spans per character from the sheet; the Backstory grid shows the same spans as rows of dated beats. The year grid's arc bands go with them. |
| plotBeats | become the **Backstory** rows (section 3): `characterId`, `year`, `title`, `worldContext`, `experienceNote`; drop `arcIds`, `arcOrders`, `chapterId` (49 set; the chapter is found from the year and the strand) |
| scene outline (meta) | keep text, breaks and versions; `ranges` (the pre-A37 form) is removed once breaks exist everywhere; add per-scene years (section 3) |

### World

| Collection | Proposal |
|---|---|
| worldEvents | keep `title`, `start`, `end`, `categoryId`, `body`, `formative`, `characterIds`; `regions` (153) stays as a filter chip; drop `reality` (real or invented is provenance), `placeIds` (0) |
| event categories list | keep the 15 groups and 111 subcategories: they are the rows of the World Events grid |
| eraStates | keep `name`, `startYear`, `endYear`, `body`; drop the five empty prose fields |
| culturalEntries | keep as **Cultural Data**: community, years, body; drop `generationNotes` (9, folded into body) |
| places | keep (41, the setting of strands and the cultural-context engine), but off the rail: edited where they are used (a chip on a chapter strand, a chip on a cultural entry) |
| glossaryTerms | keep (27, the hover meanings), off the rail: edited from the hover card's "Add meaning" |

### Knowledge, sessions, custom

| Collection | Proposal |
|---|---|
| facts, knowledgeRecords | drop. 32 facts and 26 records, the "what they know" system from the original spec; Tommy dropped its page section today. The facts become open questions or world events by a reviewed script, or are exported to a file. |
| themes | drop (16), or keep as plain tags on chapters. Decision needed. |
| openQuestions | keep, but under Sessions as "Questions" (the capture box and the importer file things there) |
| sessionLogs, briefs, findings | keep: Sessions and Continuity Checker |
| customSections, customEntries | drop (1 section, 2 entries), or keep off the rail. Decision needed. |

Net: 23 collections become 15 (characters, families, unions, parentLinks, books, parts,
chapters, backstory rows, worldEvents, eraStates, culturalEntries, places, glossaryTerms,
openQuestions, sessionLogs, briefs, findings, the meta outline) with about half the fields.

## 3. Screens

### Rail (replaces KB-1's rail and More)

Characters, Family tree, Outline, World events, Backstory, Continuity checker, Sessions,
Cultural data. Top bar as A27: story year slider and box, Writing picker, Relevant, Start session.
Dashboard folds into Sessions (its open tasks and last session are the top of that screen).
Manuscript folds into Continuity checker (the chapter text is what the checker reads). Entries,
Timeline (the current one), places, glossary, facts, themes, questions and custom sections leave
the rail; search (Cmd+K) still opens anything.

### Characters

The list on the left, the page on the right, as now, but the page is the section 2 model:
name and Chinese name as the heading, birth and death and status on one line, families as chips,
then In the story, Description, Backstory, each a text box that grows with its text. No carets
needed once there are only three texts. Relatives stay as a read-only line with links to the tree
("Parents: Frank, Laura. Partner: Dawn from 2056.").

### Outline: two connected panels

Left: the scene outline text as it is today (bullets, indent for notes, autosave, versions), with
one change: a scene's year is part of its line. A bullet that begins with a four-digit year and a
colon ("- 2051: Mark meets Dawn") is that scene's year; a bullet without one inherits the year of
the scene above it, and the first scene inherits its chapter's year. The gutter shows the year
beside every scene, in a muted colour when inherited. Years live in the text, so they are
versioned with it and need no new field.

Right: a track with one vertical bar per chapter, as tall as the lines of its scenes, in the
chapter's colour, titled with the chapter's name and part. Drag a bar to move its chapter to other
scenes; pull its top or bottom edge to change where it starts or ends; drag one bar past another
to reorder chapters. This is the PL-5 track from commit 4b2ce4a (Scenes.tsx at that commit holds
a working track, drag, resize, keyboard and tests), brought back on top of PL-6's breaks: a bar's
top edge is the chapter's break line, its bottom edge is the next chapter's break. The two panels
scroll as one, so a bar is always beside its scenes. The headings inside the text (A37) go; the
chapter is the bar.

### World events: the grid

Years left to right (2025 to 2100 by default, zoomable), one row per subcategory under its group
heading (the 15 groups and 111 subcategories of the list, in the sheet's order: Geopolitics,
Pressure Gauges, Technology, China: Industrial Capacity, Financial Systems, Military Dominance,
Resources, Demographics, Foreign Relations, US Domestic Policy, Cultural Shifts, Second Order
Effects, and the three groups the importer added). An event is a marker in its row at its year
(a bar when it has an end year), with its title on hover and as a direct label when there is room.
The era band runs across the top, the story year is a vertical line, the chapter being written is
a band. Clicking a cell with no marker adds an event in that row and year; clicking a marker opens
it in the inspector; markers drag along their row to change the year. Group headings collapse their
rows. Filter by region. The current Timeline's lifespans and strands move to the Backstory grid.

### Backstory: the character grid

The Sullivan and Li sheets, as a grid: one row per character (grouped by family, in tree order),
years left to right on the same axis as World events, a marker per backstory row (the 134 beats
plus the former voice notes and places lived) at its year. Below the grid, the selected
character's rows in order, each editable in place: year, what happens, how they experience it,
relevant world events (chosen from the events of that year). A row is added from a cell click or
"Add a moment". Lifespan bars and the chapter strands (which years each chapter covers for each
POV) draw in the same grid. Relevant to Session reads its backstory from these rows instead of the
backstory marks.

### Continuity checker, Sessions, Cultural data

Continuity checker is today's alignment view plus the manuscript panel. Sessions is Start
session, the session log, briefs, and the questions list. Cultural data is the cultural entries by
community, with the era states as a second tab (name, years, body).

## 4. How to get there without losing anything

1. **Snapshot.** The audit script's `apply` mode takes one; so does Backups. A manual snapshot
   before the migration, kept.
2. **Migration 9**, per bible: copy voice notes, places lived and plot beats into the new backstory
   rows; append relationships to the two descriptions; drop the fields; mark migrated. Everything
   it drops is in the snapshot and in the JSON export.
3. **Importer.** The East Winds mapping (A29 still open) is rewritten once, to the new model:
   High Level category rows to world events, character rows and the family sheets to backstory
   rows, chapter rows to chapters and their years.
4. **Engines.** The brief and Relevant to Session read backstory rows instead of voice notes,
   places lived and marks; the cultural-context engine reads places from "moves to" rows; the
   continuity check loses the facts step; search filters lose provenance and tags from the panel
   (they stay in the query syntax).
5. **Tests.** The fixture novel (`fixtures/novel`) is rewritten to the new model; the expected
   answers in `fixtures/expected` are regenerated and reviewed by hand.

Order of work, each a milestone with its own verification and commit: the character model and
page (smallest, proves the migration pattern); the Backstory rows and grid; the World events
grid; the Outline track; the rail; then the importer. The tree work from today (A38) stands.

## 5. Decisions needed

1. Facts and knowledge records: drop them (export to a file first), or keep off the rail?
2. Themes: drop, or keep as tags on chapters?
3. Custom sections: drop (one exists, with two entries), or keep off the rail?
4. Arcs: drop in favour of the Backstory grid, or keep as coloured spans drawn on that grid?
5. Backstory as a screen: the per-character dated rows (the Sullivan and Li sheets) is my
   reading of the sketch. Confirm, or say what it should hold.
6. Relationships (friend, rival, employer): fold into descriptions, or keep as a line on the
   character page?
7. Scene years in the text ("2051: ...") or as a separate year field per scene line?
