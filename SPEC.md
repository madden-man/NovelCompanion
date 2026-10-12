# SPEC: novel companion desktop app

Version 0.2, amended in Phase 0 on 2026-10-10 after the source material in `source-material/` was read (see `docs/SOURCE-MANIFEST.md` and `docs/PHASE0-FINDINGS.md`). Amendments are numbered A1 to A32 in the log at the end of section 10 and marked inline as `[A#]`. After I approve it, this file is the single authority: every piece of work is checked against the numbered criteria here.

Each criterion has an ID (for example `FT-4`). A criterion passes only when there is a named automated test or a recorded manual check for it in `PROGRESS.md`.

---

## 1. Purpose and scope

A single-user desktop app that holds the story bible for a novel and produces a focused brief before each writing session. The app is general `[A16]`: it holds any number of bibles (one per novel, all inside the single database `novel_companion`, switched in settings), and nothing about a particular book is written into code. The first bible, and the example used throughout this spec and the tests' spirit, is East Winds (2025 to 2100, the Sullivan and Li families, San Francisco and Jinan in Shandong `[A1]`).

**In scope:** storing and editing all story knowledge, a visual family tree, timeline and age calculations, session briefs, continuity checks, Claude running inside the app, import from Excel and Word, Google Drive import and backup.

**Out of scope:** replacing my writing editor, multi-user collaboration, mobile, two-way Drive sync, publishing or formatting the manuscript.

## 2. Definitions

- **Entry**: any record in the story bible (a character, event, place, plot beat, and so on).
- **Status**: every entry is `canon` (established in a written chapter), `planned`, or `idea`.
- **Provenance**: every entry is `researched` (with a source note) or `invented`, or unset.
- **Story year**: the year in which something happens in the novel. Backstory may fall before 2025, so years outside 2025 to 2100 are valid everywhere.
- **Reading order**: the position of a chapter in the book, which may differ from chronological order.
- **Current position**: the last chapter in reading order marked as written.

## 3. Architecture

Defaults; Phase 0 may amend them with a stated reason.

- **ARCH-1** Electron app in TypeScript. The main process owns the database, the file system, the keychain, and all network calls. The renderer (React) has no direct network or key access and talks to the main process through a typed interface.
- **ARCH-2** `[A2]` MongoDB (the Atlas deployment I provide) holds the bible, with versioned migrations recorded in a schema-version document. Full-text search is an in-process index built from the database in the main process and updated on every write, tokenizing Chinese by character bigrams and English by words, so it behaves identically against Atlas and against the local MongoDB the tests use. The main process also keeps an in-memory read model of the bible, refreshed on every write, and every deterministic query in this spec (ages, timeline, tree, brief selection, continuity) runs against it rather than round-tripping to the database.
- **ARCH-3** `[A2]` The MongoDB database is the source of truth. Drive is an import source and a backup target. Local snapshots (`BK-1`) are the rollback mechanism.
- **ARCH-4** `[A3]` `[A23]` Claude runs through the Claude Agent SDK from the main process, authenticated with an Anthropic API key held in the macOS keychain (service `novel-companion-anthropic`), set and replaced from the settings screen and never shown in full. Anthropic's SDK terms do not allow subscription login for SDK-built products, so that route is not used. The SDK bundles its own Claude Code binary; the installed CLI is not required. If the key is missing or rejected, the app says so and links to the settings screen. SDK usage and model names are checked against current Anthropic documentation at M6; the settings model lists come from the live models endpoint. The model is a setting per feature (`DB-4`).
- **ARCH-5** `[A2]` The MongoDB connection string, Drive tokens, and any API key are stored in the macOS keychain, never in the database, logs, exports, or the repository.
- **ARCH-6** `[A2]` The app needs a connection to the MongoDB deployment. When it cannot connect, it says so in plain language, offers to open the most recent local snapshot read-only, and never pretends a write succeeded. Claude and Drive are the only features that need any other network access.
- **ARCH-7** No telemetry or analytics of any kind.
- **ARCH-8** `[A16]` `[A22]` Multiple bibles. The app uses exactly one database, `novel_companion`, and never reads or writes any other database on the cluster. Inside it, a `bibles` collection registers each bible, and each bible's data lives in its own collections named `<bibleId>.<collection>` (for example `eastwinds.characters`), so bibles share nothing. The app lists bibles, creates a new empty one, and switches between them. Every list in section 4 that has defaults (families, communities, union types, categories, eras, romanization systems) is seeded per bible on creation and editable per `ED-8`; the East Winds values arrive through import, not from code.

## 4. Data model

All entries share: ID, title, body (rich text), status, provenance and source note, tags, created and modified times, links to other entries, and revision history.

| Entity | Additional fields |
|---|---|
| Family | name, notes, display color |
| Character | names (see `CH-2`), birth date, death date, birthplace, family memberships, backstory, voice notes as a list of (story year or age, text) `[A9]`, places lived with year ranges |
| Union | two characters, type (married, partnered, other), start year, end year, end reason |
| Parent link | parent, child, type (biological, adoptive, step, guardian), start year |
| Relationship | two characters, free-text type (friend, rival, employer), year range |
| Book / Part | `[A5]` books contain parts, parts contain chapters; each has a number, title, and summary |
| Arc | name, scope (whole book, Sullivan, Li, a character, or custom), owner character (optional), story year range, summary `[A6]` |
| Chapter | part, reading-order number, title, one or more strands `[A5]` (each: label such as "present" or "backstory", story year or year range, point-of-view character, characters present, places; exactly one strand is primary and supplies the chapter's story year wherever this spec says "story year"), arcs, themes, facts in play (see `KN-3`), written flag, manuscript text, summary, source file |
| Plot beat | arcs (zero or more), chapter (optional), story year, point-of-view character, description, world context note, experience note (how the point-of-view character experiences it), order within arc `[A7]` |
| World event | date or year range, real or invented, category (a user-editable hierarchy, for example Technology > Robotics), regions, places, characters affected, formative flag `[A8]` |
| Era state (was "decade state") | name, year range, technology, climate, economy, politics, daily life `[A8]` |
| Cultural entry | community (San Francisco, Jinan / Shandong, Chinese diaspora in California, evangelical church, or custom) `[A1]`, year range it applies to, generation notes |
| Place | parent place, descriptions by year range |
| Glossary term | term in characters, romanization, language, meaning, usage note |
| Fact | a secret or piece of family history |
| Knowledge record | fact, character, year learned, chapter learned (optional), how |
| Theme / motif | description, appearances (chapters) |
| Open question | question, linked entries, state (open, decided), decision |
| Session log | date, chapter worked on, where I stopped, notes |
| Custom section | see section 5.14 |

Dates may be a full date, a year, or unknown. Lists of types (union types, parent-link types, communities, tags) are user-editable, not fixed in code.

---

## 5. Features and acceptance criteria

### 5.1 Editing (applies to everything)

- **ED-1** Every field of every entity in section 4 can be created, changed, and deleted through the interface. There is no data that can only be changed by re-importing or by editing the database.
- **ED-2** Changes save automatically within one second, with no save button.
- **ED-3** Undo and redo work for at least the last 50 changes in a session, including deletions and tree edits.
- **ED-4** Every entry keeps a revision history. I can view any earlier revision, compare it with the current one, and restore it.
- **ED-5** Deleting moves an entry to a trash from which it can be restored with its links intact. Before deleting, the app lists the entries that link to it.
- **ED-6** Generated content (chapter summaries, briefs, continuity findings) and imported content are editable like anything else.
- **ED-7** Re-import, Claude, and bulk actions never overwrite my edits without showing me the change and getting my approval.
- **ED-8** Type lists, family names, tags, section names, and decade ranges are editable. Renaming one updates every entry that uses it.
- **ED-9** Any entry can be linked to any other by typing `@` and searching. Each entry shows what links to it.
- **ED-10** Invalid input (for example a death date before a birth date) is flagged at the field with a plain explanation. Warnings never block saving; this is fiction and I may mean it.

### 5.2 Characters

- **CH-1** Create, edit, and delete characters with all fields in section 4. A character can belong to zero, one, or several families.
- **CH-2** Names support: full name, name in Chinese characters, romanization, name order (family name first or last), birth name, married name, nicknames, and what each other character calls them.
- **CH-3** The character page shows current-position age, a personal timeline (own events, world events in their lifetime, chapters they appear in), relatives, and what they know.
- **CH-4** A character with an unknown birth year is allowed and is reported as "age unknown" everywhere, never estimated.

### 5.3 Family tree

- **FT-1** One overall tree shows every family together, including the links between the Sullivans and the Lis. I can filter to one family, or to the ancestors and descendants of one person.
- **FT-2** The tree is fully editable in place: add a person; add a parent, child, sibling, or partner from any node; change or remove any link; change link and union types; delete a person (following `ED-5`).
- **FT-3** Edits in the tree and edits on character pages are the same data. A change in one appears in the other immediately.
- **FT-4** The tree supports multiple unions per person, ended unions, half-siblings, adoptive, step, and guardian links (drawn distinctly from biological ones), people with one or no known parents, and people in no family.
- **FT-5** A year control redraws the tree for any year: who is unborn, alive (with age), or dead, and which unions are active.
- **FT-6** The app prevents a person from being their own ancestor. It warns, without blocking, on: a parent under 12 or over 60 at a child's birth, a child born more than a year after a parent's death, overlapping unions, and a child born before a union started.
- **FT-7** Each node shows name, years, and status. Selecting a node opens the full character for editing without leaving the tree.
- **FT-8** The tree stays readable and responsive with 200 people across six generations: pan, zoom, collapse and expand branches, and fit to window. The tree takes the panel's whole visible height, and a Full screen control shows the tree and its inspector on the whole screen; Escape or the control leaves it `[A26]`.
- **FT-9** The tree can be exported as an image and as a PDF.
- **FT-10** Layout is stable: adding one person does not rearrange unrelated branches.

### 5.4 Timeline and ages

- **TL-1** All age and alive-or-dead results are computed in code, never by a model.
- **TL-2** For any year, the app lists every character as alive (with age), dead (with year of death), not yet born, or unknown.
- **TL-3** With year-only birth data, age in year Y is Y minus birth year. With full dates, age is exact for a given date.
- **TL-4** In the year of death a character is listed as alive and flagged as dying that year.
- **TL-5** For any character and year, the app lists the world events they have lived through and their age at each.
- **TL-6** A timeline view shows world events, decade states, chapters, and character lifespans on one axis, filterable by family, place, and status. Items can be edited from the timeline. World events also have a strip of year columns, titles only, each opening its event: the whole span on the World events section, and the SB-2 window in every "Relevant to Session" strand `[A33]`.
- **TL-7** Two characters can be compared: ages side by side across a year range.

### 5.5 Plot

- **PL-1** Arcs exist for the whole book, the Sullivan family, the Li family, and any I add. A beat or chapter can belong to several arcs.
- **PL-2** `[A6]` An outline view is a grid: one row per chapter in reading order (grouped by book and part), one column per story year, with each chapter's strands and each arc drawn as spans across the years they cover. It can be flipped to story-year order. This reproduces the "High Level" sheet of my workbook.
- **PL-3** Beats and chapters can be reordered by dragging. Reading order and chronological order are tracked separately.
- **PL-4** Each chapter shows its beats, characters present with ages in that story year, places, themes, and facts in play.

### 5.6 World events and decade states

- **WE-1** Events can be a single date, a year, or a range; real or invented; linked to places and characters; filed under a category and regions `[A8]`. The category list is editable per `ED-8` and the timeline (`TL-6`) can be filtered by it.
- **WE-2** Era states cover 2025 to 2100 with no gaps by default; the default eras are the sections of my World Development document, not fixed ten-year blocks `[A8]`. Ranges are editable, and overlaps or gaps are flagged.
- **WE-3** For any year, the app returns the era state that applies and the events up to that year.

### 5.7 Culture, places, glossary

- **CU-1** Cultural entries are organized by community and by the years they apply to, so the same tradition can be described differently in 2030 and 2080.
- **CU-2** For a given community and year, the app returns the entries that apply.
- **PC-1** Places nest (city, district, building) and hold descriptions by year range.
- **GL-1** Glossary terms store characters, romanization, language, and meaning. One romanization system per language is set in settings, and terms that do not follow it are flagged.
- **GL-2** Searching finds a term by its characters, its romanization (with or without tone marks), or its meaning.
- **GL-3** `[A10]` Chinese characters are shown as characters everywhere (names, glossary, body text, labels, tree nodes). Hovering over them, or focusing them with the keyboard, shows the romanization and meaning from the matching glossary term; character names link to their glossary term automatically, and a run of characters with no glossary term shows a one-click "add to glossary" action.

### 5.8 Knowledge states

- **KN-1** For any fact, the app shows who knows it and from when. For any character and year, it shows what they know and do not know.
- **KN-2** A character cannot be recorded as learning a fact before they are born; this is a warning per `ED-10`.
- **KN-3** A chapter can list facts in play: which characters act on which facts. This is what the continuity check uses in `CC-2`.

### 5.9 Themes, open questions, session log

- **TH-1** Themes and motifs list every chapter they appear in, with a note for each appearance.
- **OQ-1** Open questions can be linked to any entry, marked decided with the decision recorded, and filtered by state.
- **SL-1** Ending a session prompts for where I stopped. The next launch shows that note first.

### 5.10 Manuscript

- **MS-1** Chapters can be imported from Word files or Google Docs and linked to their source file. Text formatting that carries meaning (italics, scene breaks) is kept.
- **MS-2** Marking a chapter as written offers a generated summary. Nothing is saved until I approve or edit it.
- **MS-3** Marking a chapter as written offers to promote the planned entries it establishes to `canon`, as a list I approve item by item.
- **MS-4** Re-importing a changed chapter shows a text diff and marks its summary as possibly out of date.
- **MS-5** `[A4]` The app never edits the manuscript. There is no code path that writes to a manuscript file or Google Doc; the manuscript text held in the bible is a read-only import.

### 5.11 Session brief

- **SB-1** Inputs: a chapter, or a story year plus point-of-view character, with optional place and other characters present.
- **SB-2** Entries are selected by deterministic queries, defined here. If the chapter has more than one strand, steps 1 to 6 run once per strand and the brief has one section per strand, the primary strand first `[A5]`:
  1. Characters present, with ages. If none are listed, the point-of-view character and their living parents, partners, children, and siblings.
  2. The era state covering the story year.
  3. World events in a five year window around the story year: the three years before it (the window is a setting) through the year after it `[A33]`, plus any event marked formative within the lifetime of a character present, plus events linked to the chapter's places. Events after the story year stay under "Planned ahead" (SB-5).
  4. Cultural entries matching the place's community and the story year.
  5. Place descriptions for the story year.
  6. What each character present knows, and facts others present know that the point-of-view character does not.
  7. Summaries of the three previous chapters in reading order, the previous chapter in each of this chapter's arcs, and the previous chapter with the same point-of-view character.
  8. Beats planned for this chapter, and unresolved beats from earlier chapters in its arcs. An unresolved beat is one in any of this chapter's arcs whose story year is at or before this story year and which is assigned to no chapter or to a chapter not marked written `[A18]`.
  9. Glossary terms, themes, and open questions linked to anything selected above. Linked means: a glossary term linked to a selected entry or whose characters appear in a selected character's names; a theme with an appearance in a selected chapter or this chapter; an open question linked to any selected entry `[A18]`. Decided questions linked the same way are included with their decision, under their own heading ("Decided"), separate from still-open questions `[A24]`.
  10. The last session log note for this chapter.
- **SB-3** The selection is saved as a manifest of entry IDs. For the same inputs and data, the manifest is identical every time.
- **SB-4** Claude writes the brief from the manifest's contents only. Every item in the brief cites entry IDs, and code verifies each cited ID is in the manifest; anything that fails is flagged visibly.
- **SB-5** The brief keeps canon and planned material visibly separate, and never includes events after the story year except under a labelled "planned ahead" heading.
- **SB-6** If the selection exceeds the size budget (measured in characters of the selected entries' text, default 40,000, a setting), items are dropped in this fixed priority order, lowest first: open questions, themes, glossary, place descriptions, cultural entries, world events beyond the window, previous-chapter summaries, beats, knowledge, era state, characters present, session-log note `[A18]`. The brief says what was left out. The three DB-2 lead sections are never dropped; if they alone exceed the budget, all are kept and the brief says it is over budget `[A25]`.
- **SB-7** If Claude is unavailable, the app shows the selected entries as a structured brief with no synthesis.
- **SB-8** Briefs are saved, editable, linked to their chapter, and exportable as Markdown and PDF.
- **SB-9** I can add or remove entries from the selection and regenerate.
- **SB-10** `[A28]` A Relevant to Session view, reachable from every screen, shows the `SB-2` selection live for the chapter strand picked in Writing (or a story year plus point-of-view character when none is picked): characters present with ages, world events, cultural expectations, places, knowledge, beats, previous chapters, and linked glossary terms, themes, and questions. Every item opens its entry. It is the same selection the brief uses, with no Claude involved.

### 5.12 Continuity check

- **CC-1** Runs on one chapter or the whole manuscript, on demand.
- **CC-2** Structural checks, in code: a character present in a chapter while dead or unborn in its story year; a character acting on a fact before the year they learn it; an event linked to a chapter as having happened but dated after its story year; tree warnings from `FT-6`; a chapter's story year outside its point-of-view character's lifetime.
- **CC-3** `[A20]` Alignment checks, by Claude: the chapter text is compared with the entries selected for it and with the plot as stored: the chapter's strands and years, its beats, beats in its arcs dated before its story year, chapter order, and the facts in play. Each finding quotes the chapter passage with its line numbers, cites the conflicting entry or beat, and explains the conflict. The check runs on one chapter or the whole manuscript at any time (`CC-1`) and uses the model configured for continuity, default `claude-opus-5-5`.
- **CC-4** `[A20]` Each finding offers three resolutions. **Manuscript wins:** the finding carries a prepared change set to the bible (the entries, beats, or strands that would make the bible match the chapter); the change set is shown as a diff, and one click applies all of it through the normal write path, recorded in revision history and undoable. **Rewrite recommended:** the finding becomes a rewrite task listing the exact manuscript lines (chapter, line numbers, quoted text) and a plain description of what must change to match the bible; it never contains replacement prose (`AI-4`). Open rewrite tasks are listed on the dashboard (`DB-1`) and on the chapter. **Dismiss.** Dismissed findings do not reappear unless the text or the entry changes.
- **CC-5** Structural checks produce no findings on the fixture novel's clean chapters and find every planted structural error (section 7).

### 5.13 Claude panel `[A19]` `[A21]`

- **AI-1** A question panel is available from every screen: I ask questions about the bible and the manuscript, with streaming responses, a stop button, and saved conversation history. Claude also runs inside four features, each started by a named control and fed only by deterministic selection: session briefs (`DB-2`, `SB-4`), alignment checks (`CC-3`), chapter summaries (`MS-2`), and import proposals (`IM-5`). Every run streams, can be stopped, and is saved with the feature that produced it.
- **AI-2** In the panel Claude reads the bible through read-only tools: search entries, get an entry, query the timeline for a year, get a person's relatives, get a chapter. The panel shows which entries were read for each answer; each feature run shows which entries it was given.
- **AI-3** Claude has no tool that writes to the bible. It can only submit proposals (create, change, delete, link), which appear in a review queue showing the exact change. Nothing is saved until I approve, and I can edit a proposal before approving.
- **AI-4** Claude never drafts prose for the novel. No screen, setting, or control asks Claude for prose, the system prompt for the panel and for every feature forbids it, and if I ask for prose in the panel Claude declines in one sentence and offers the bible facts instead. A test asserts that every system prompt contains the prohibition and that a recorded "write the scene" request in the panel yields a refusal with no prose.
- **AI-5** Imported text is treated as material to analyse, never as instructions to Claude.
- **AI-6** On first use, the app states plainly that content used in Claude features is sent to Anthropic, and which features do that.
- **AI-7** Failures (no network, bad key, rate limit) show a clear message and never lose my input or corrupt data.

### 5.14 Custom sections

- **CS-1** I can create a new section with my own fields: text, long text, number, year, year range, single choice, tags, and link to entry.
- **CS-2** Custom entries have status, provenance, links, history, search, import, and export like built-in ones.
- **CS-3** A custom section can be included in brief selection by a rule I choose: linked to the chapter, matching the story year, or always.

### 5.15 Search

- **SR-1** One search box covers every entry, chapter text, and brief, in English and Chinese.
- **SR-2** Results can be filtered by section, status, provenance, family, place, tag, and year range.

### 5.16 Import

- **IM-1** Excel import has a mapping step: each sheet to a section, each column to a field, with a preview. The mapping is saved per file. Two sheet shapes are supported `[A12]`: a table (one row per entry) and a grid (row label by year column, where every non-empty cell becomes one entry dated by its column and categorized by its row label and the nearest heading row above it).
- **IM-2** Rows that fail are reported with the reason, and the rest import. Nothing is silently dropped.
- **IM-3** Re-importing the same file updates existing entries instead of duplicating them, and follows `ED-7`.
- **IM-4** Word import brings a document in as a character backstory, a chapter, or a general note, keeping headings.
- **IM-5** Optionally, Claude reads an imported document and proposes structured entries (characters, dates, relationships, events) through the review queue in `AI-3`.
- **IM-6** Every imported entry records its source file and location in it.
- **IM-7** `[A13]` When two sources, or two versions of one source, give different values for the same field, the importer keeps the value from the most recently modified source and creates an open question (`OQ-1`) that lists every source and its value, so I can edit through them.

### 5.17 Google Drive

- **GD-1** Sign-in uses Google's desktop sign-in flow with read-only access for import. Scopes are checked against current Google documentation and are the narrowest that work.
- **GD-2** I choose files and folders to link. Word, Excel, Google Docs, and Google Sheets files are supported.
- **GD-3** On launch and on demand, the app reports which linked files changed. It never applies changes without showing them to me.
- **GD-4** Export writes the whole bible to a Drive folder I choose, as Markdown (one file per entry, organized by section) and one JSON file. Export uses access limited to files the app creates.
- **GD-5** Disconnecting removes stored tokens. The app works fully without Drive.

### 5.18 Backup and export

- **BK-1** `[A2]` A snapshot (a complete local JSON dump of every collection, written to the app's data folder) is taken daily, before every import, restore, and bulk change, and on demand. The last 30 are kept; the number is a setting.
- **BK-2** `[A2]` Any snapshot can be restored into the database, and restoring takes a snapshot first. Restore replaces every collection in one transaction or fails without changing anything.
- **BK-3** The JSON export imports into an empty app with nothing lost: every entry, link, revision, and setting is identical.
- **BK-4** `[A2]` A forced quit during editing loses no more than the last second of typing. Every save is a single-document write or a multi-document transaction, so a partial edit is never persisted.

### 5.19 Settings

- **ST-1** `[A3]` `[A17]` `[A19]` Settings cover: Claude model per feature (briefs default Opus) and sign-in status, brief window and size budget, romanization systems, snapshot count, MongoDB connection (stored in the keychain, shown masked), Drive connection, and light or dark appearance.

### 5.20 Story time `[A11]`

- **TM-1** A Story Time dialog opens from every screen with one shortcut. It holds the current story time: a year or a full date, and optionally the chapter and strand I am writing. A bar above every screen also holds a story year slider and year box (with the era), a Writing picker for the chapter strand I am writing, Start session (`DB-2`), and Relevant to Session (`SB-10`); picking a chapter strand in Writing sets the story year to that strand's year `[A27]`.
- **TM-2** The dialog shows, for that time: every character's state and age (same code as `TL-2`), the era state, the events of that year, and which chapters' strands fall in that year.
- **TM-3** The current story time drives the tree year control, the timeline cursor, the default brief inputs, and the ages shown on character pages, until I change it. It persists across launches and is shown in the status bar.
- **TM-4** The time can be set by anchor: pick a character and an age ("Mark is 19") and the year is computed; pick a chapter strand and its year is used; or step the year by one or ten.
- **TM-5** Setting the time never writes to any entry. Promoting a time to a chapter strand's year is an explicit action that follows `ED-7`.

### 5.21 Dashboard and Start session `[A17]`

- **DB-1** The app opens on a dashboard: the last session-log note (`SL-1`), the current story time (`TM-1`), the current position in reading order, open questions count, open rewrite tasks (`CC-4`), and two primary controls, "Start session" and "Check alignment" (`CC-1`).
- **DB-2** Start session takes a section of plot: a part, a chapter, a chapter strand, or a story year plus point-of-view character (the same inputs as `SB-1`). It runs the `SB-2` selection, then has Claude synthesize the brief with these three sections first and always present: (1) the characters in the section and their ages at its story year, (2) the world events ongoing at that time, (3) the cultural expectations bearing on those characters at that moment. The remaining `SB-4` sections follow. Every rule in `SB-3` to `SB-9` applies; the `SB-6` budget never drops these three sections `[A25]`.
- **DB-3** Starting a session creates a session-log entry linked to the section and the brief, and sets the story time to the section's year.
- **DB-4** The brief is generated with the model configured for briefs, default `claude-opus-5-5`. Settings (`ST-1`) hold a model per Claude feature: briefs (default Opus), alignment checks (default Opus), chapter summaries, import proposals, and the question panel.

### 5.22 Knowledge base shell `[A34]`

The app is a knowledge base first. Adding a fact about the world is one keystroke and one sentence; finding anything is one of five screens. Everything older stays reachable, but out of the way.

- **KB-1** The rail holds five screens, in this order: Characters, Family tree, Outline, Timeline, Entries. Everything else (Dashboard, Manuscript, Relevant to Session, Start session, every raw section list including Families, Unions, Parent links, Relationships, Books, Parts, Arcs, Chapters, Plot beats, World events, Era states, Session log, Briefs, Continuity findings, Custom sections, and Search and filters, Review queue, Import, Backups, Google Drive, Lists, Trash, Bibles, Settings) sits under one "More" disclosure at the bottom of the rail, closed by default, remembering its state for the bible. The top bar keeps the story year, Writing, Relevant to Session and Start session; the app still opens on the dashboard (`DB-1`).
- **KB-2** The Year view and Compare are no longer screens. The Story Time dialog (`TM-1`, `TM-2`) is the year view: right under the time controls it lists every character's state and age at that time (`TL-2`, `TL-4`), then the world for that year: the era state that applies (`WE-3`), the world events strip for the five-year window (`A33`) and the chapter strands in that year. Compare (`TL-7`) is a disclosure inside the dialog. The year box and era name in the top bar are also a button that opens the dialog, as Cmd+T does.
- **KB-3** One outline. Books, parts, arcs, chapters and plot beats are created, renamed, reordered, moved between parts and deleted inside the Outline screen without leaving it: a part from a book heading, a chapter from a part heading, a beat from the chapter page or from an arc. The chapter page in the outline's inspector edits strands (label, primary, year or range, point of view, characters present, places), arcs, themes and facts in play. Reordering works by drag and by keyboard (`PL-3`). Books, Parts, Arcs, Chapters and Plot beats have no rail item of their own (they are under More).
- **KB-4** The Timeline screen is the world. The `TL-6` chart sits at the top, then the whole-span world events strip (`A33`), then a list of the world events and era states in view, each opening in the inspector for editing; new world event and new era state start from this screen. World events and Era states have no rail item of their own.
- **KB-5** One Entries screen lists facts, cultural entries, places, glossary terms, themes and motifs, open questions and custom entries together, newest first, with a kind filter (one chip per kind, several at once), a status filter and a search box. New entry picks a kind in the same screen and opens the `ED-1` editor beside the list. Culture by year, Place tree, Romanization and Glossary table are tabs of the Entries screen, not rail items. Facts, Cultural entries, Places, Glossary, Themes and motifs, Open questions and custom sections have no rail item of their own.
- **KB-6** Capture. On every screen Cmd+K (and an Add button in the status bar) opens a capture box with one text field and the story time shown. Enter sends the text to Claude (feature `capture`): with the `AI-2` tools Claude looks up what the text names and proposes, through `propose_change`, the entries to create, change or link, so that the fact lands on the right entry (a character's places lived or voice note, a world event with its year, a place, a cultural entry, a fact linked to the characters it concerns) and, when the text gives no year, carries the story year. Each proposal appears in the box as it is made, as the `ED-7` diff. "File it" (Cmd+Enter) approves the ticked proposals and shows what was filed with links; an unticked one is rejected; "Review later" leaves them pending in the review queue; Escape closes the box and leaves them pending. Nothing is written before approval (`AI-3`); a filing is one undo step (`ED-3`). Filed entries default to status `idea` unless the text states canon, and their provenance names the capture. The system prompt carries the prose prohibition (`AI-4`) and the capture text is material (`AI-5`).
- **KB-7** Capture offline. Without a key, offline, or when the run fails, Enter saves the text as an open question tagged `capture` with the story time, says so in the box, and nothing is lost (`AI-7`).
- **KB-8** Every screen and control above is keyboard reachable with the contrast and copy standards (`NF-2`), and the existing e2e tests that reached a removed rail item reach the same content on its new screen.

---

## 6. Quality requirements

- **NF-1** With 5,000 entries and 100 chapters: launch under 3 seconds (including connecting to Atlas and loading the read model), search under 200 milliseconds, any timeline query under 100 milliseconds, tree redraw under 500 milliseconds.
- **NF-2** Every action is reachable by keyboard. Text meets standard contrast guidelines in both appearances.
- **NF-3** Errors are shown in plain language with what to do next. No raw error codes without an explanation.
- **NF-4** The app builds into an installable package for my operating system.

---

## 7. Fixture novel and known answers

Tests run against a small invented novel, never my real material. Expected answers are written by hand from the rules in this spec and stored in `fixtures/expected/`. They must never be generated by the code under test.

**People**

| ID | Name | Born | Died | Notes |
|---|---|---|---|---|
| H1 | Margaret Hale | 1958 | 2041 | Married to H2, 1982 to 2030 |
| H2 | Peter Hale | 1956 | 2030 | |
| H3 | Daniel Hale | 1985 | | Child of H1 and H2. Married to Z3 from 2029 |
| H4 | Ruth Hale | 1990 | 2067 | Child of H1 and H2 |
| H6 | Sam Hale | 2012 | | Adopted by H4 in 2015 |
| Z1 | Zhou Meiling (周美玲) | 1962 | 2050 | Partner of Z2 |
| Z2 | Zhou Wei | 1960 | 2055 | |
| Z3 | Zhou Lan | 1988 | | Child of Z1 and Z2. Raised in Guangzhou |
| Z4 | Zhou Jun | 1993 | 2070 | Child of Z1 and Z2 |
| H5 | Iris Hale-Zhou | 2031 | | Child of H3 and Z3; in both families |
| X1 | Tomas Reyes | 2030 | | No family. Union with H5, 2056 to 2064 |
| Z5 | Noor Zhou | 2058 | | Child of H5 and X1 |
| U1 | The Archivist | unknown | | No family |

**Known answers for `TL-2`**

- Year 2040. Alive: H1 82, H3 55, H4 50, H5 9, H6 28, Z1 78, Z2 80, Z3 52, Z4 47, X1 10. Dead: H2. Unborn: Z5. Unknown: U1.
- Year 2041. H1 is alive at 83 and flagged as dying that year.
- Year 2075. Alive: H3 90, H5 44, H6 63, Z3 87, X1 45, Z5 17. Dead: H1, H2, H4, Z1, Z2, Z4. Unknown: U1.

**The fixture also contains** at least 10 world events (one dated 2090) filed under at least three categories, an era state for each decade, cultural entries for two communities with year ranges, 5 glossary terms with Chinese characters, 2 facts with knowledge records (one learned by H5 in 2060), 8 chapters out of chronological order grouped in two parts, one of which has two strands (a present strand in 2045 and a backstory strand in 2032) `[A5]`, an Excel workbook with one table sheet and one grid sheet `[A12]`, and one custom section.

**Planted errors**

| ID | Type | Error |
|---|---|---|
| S1 | Structural | Chapter 4 (story year 2032) lists H2 as present; H2 died in 2030 |
| S2 | Structural | Chapter 6 (2045) has H5 acting on a fact H5 learns in 2060 |
| S3 | Structural | Chapter 6 (2045) links the 2090 event as having happened |
| P1 | Prose | Chapter 5 (2040) text calls Margaret "seventy"; she is 82 |
| P2 | Prose | Chapter 7 text says Lan grew up in Shanghai; the bible says Guangzhou |

All other chapters are clean and must produce no structural findings.

---

## 8. Test plan

- **T-1 Unit tests** cover all deterministic logic: ages, alive-or-dead, tree validation, brief selection, structural checks, romanization checks, import mapping.
- **T-2 Integration tests** run against a real MongoDB (a local server started by the test harness, never Atlas) with the fixture loaded `[A2]`: Excel and Word import, re-import without duplicates, brief generation end to end, continuity check, proposal approval, snapshot and restore, JSON round trip, Drive import and export against a mocked Drive.
- **T-3 Claude calls** are replaced by recorded responses in the main suite. A separate live suite, run on demand, checks the real integration and reports whether P1 and P2 are found; it informs but does not gate.
- **T-4 End-to-end tests** launch the packaged app and drive: creating and editing each entity type, building a tree by hand that matches the fixture, moving the year control, generating a brief, approving and rejecting a proposal, undo and redo, delete and restore.
- **T-5 Editing coverage**: an automated test walks every field of every entity in section 4 and confirms it can be changed and that the change persists after restart. A field with no test fails `ED-1`.
- **T-6 Performance tests** generate the data volume in `NF-1` and assert the limits.
- **T-7** The full suite runs from one command and must pass before any milestone is closed.

---

## 9. Milestones and verification

| # | Milestone | Criteria |
|---|---|---|
| M0 | Project scaffold, test harness, fixture novel and expected answers | ARCH-1, 2, 7, 8; section 7; T-7 |
| M1 | Data model, generic editing, history, undo, trash, links | ED-1 to 10; T-5 |
| M2 | Characters and family tree | CH-1 to 4; FT-1 to 10 |
| M3 | Timeline, ages, world events, era states, story time | TL-1 to 7; WE-1 to 3; TM-1 to 5 |
| M4 | Plot, culture, places, glossary, knowledge, themes, questions, log, custom sections, search | PL, CU, PC, GL, KN, TH, OQ, SL, CS, SR |
| M5 | Excel and Word import, snapshots, export | IM-1 to 4, 6, 7; BK-1 to 4 |
| M6 | Claude panel, tools, proposal queue, import proposals | ARCH-4, 5; AI-1 to 7; IM-5 |
| M7 | Manuscript, session brief, dashboard | MS-1 to 5; SB-1 to 9; DB-1 to 4 |
| M8 | Continuity check | CC-1 to 5 |
| M9 | Google Drive | GD-1 to 5 |
| M10 | Settings, performance, packaging, final audit | ST-1; NF-1 to 4; ARCH-6; every criterion re-checked |
| M11 | Knowledge base shell: rail, year dialog, one outline, world timeline, entries, capture | KB-1 to 8 `[A34]` |

**Verification protocol, for every milestone**

1. The builder subagent receives the milestone's criteria and writes code and tests.
2. The architect runs the full suite itself.
3. A reviewer subagent with fresh context receives only this spec and the code. For each criterion it reports pass or fail with evidence: the test name and what the test actually asserts. A test that exists but does not really exercise the criterion is a fail.
4. Failures go back to a builder with the specific evidence. Repeat from step 2.
5. On a full pass, `PROGRESS.md` records each criterion, its status, and its evidence, and the work is committed.
6. Earlier milestones' tests keep passing. A regression blocks the current milestone.

The spec is not changed to make a failing criterion pass. If a criterion turns out to be wrong or impossible, the architect stops and asks me.

---

## 10. Decisions for Phase 0

Answered on 2026-10-10. Tommy confirmed the same day: option A (Atlas is the store), the single database `novel_companion` on cluster0 (`A22`), Shandong, the Pacific States Compact premise over PEU secession, and requiring the Claude Code CLI to be signed in for Claude features (superseded by A23). Dawn's and Xuan's birth years are left to the importer's open questions (`IM-7`). The connection string is in the macOS keychain under service `novel-companion-mongodb`, account `novel-companion`. Items below that said "to confirm" are now confirmed.

1. **Operating system:** macOS (this Mac runs macOS 14). The only packaging target for `NF-4`.
2. **Claude authentication:** Anthropic API key in the keychain through the Claude Agent SDK (`A23`, superseding `A3`).
3. **Manuscript:** written in the Google Doc "East Winds". The app imports it and never edits it (`A4`, `MS-5`).
4. **Mapping of the real material to section 4:** see `docs/PHASE0-FINDINGS.md` section "Mapping to the data model" and amendments `A5` to `A9`, `A12`. Missing from the data model before amendment: books and parts, chapters with two time strands, arcs owned by a character with year ranges, beats with a point-of-view character and experience notes, event categories, era states with non-decade ranges, year-stamped voice notes.
5. **Romanization:** Hanyu Pinyin for Mandarin, tone marks optional in search. The material is set in Jinan, Shandong, so Cantonese does not appear; the romanization setting stays per-language and editable, and Jyutping can be added if Guangdong material ever appears. To confirm: Shandong, not Guangdong, is the setting (`A1`).
6. **Order:** not chronological. The book is in chiasm form (Book One: Sins of the Father, Lost Spirits, Inheritance, Circulation; Book Two: I Take Refuge in You), and each chapter carries a present strand and a backstory strand set in different years (`A5`).
7. **Architecture amendments:** MongoDB Atlas replaces SQLite (`A2`, Tommy's instruction); Agent SDK with subscription login (`A3`, superseded by A23). To confirm: option A in the findings (Atlas is the store) versus option B (local store, Atlas as backup target); the amendments below assume A.

**Amendments log**

| # | Where | Amendment | Reason |
|---|---|---|---|
| A1 | 1, section 4 Cultural entry, 10.5 | Setting is San Francisco and Jinan, Shandong, not Guangdong. Default communities updated. | Every source places the Li family in Jinan, Shandong (Dawn born there; Qin meets Siyuan at a shrine by a stream in Jinan). The build prompt said Guangdong. |
| A2 | ARCH-2, 3, 5, 6; BK-1, 2, 4; T-2; NF-1 | MongoDB Atlas is the store. Search and all deterministic queries run on an in-process read model. Snapshots are local JSON dumps. Offline opens the last snapshot read-only. | Tommy asked for MongoDB persistence. Atlas is remote, so the offline guarantee cannot stand as written; in-process search keeps Chinese search working without Atlas Search and keeps tests runnable against a local server. |
| A3 | ARCH-4, ST-1, 10.2 | Agent SDK with Claude subscription login; no API key setting. Permission for SDK subscription use verified at M6. | Tommy's choice. |
| A4 | MS-5, 10.3 | The app never edits the manuscript. | Tommy's instruction. |
| A5 | Section 4 Book/Part and Chapter rows, SB-2, section 7 | Books and parts added. A chapter has one or more strands (label, years, point of view, cast, places); one is primary. Briefs run per strand. | The High Level sheet gives every chapter two dated threads, for example "Ch. 1: Mark Feels Free" has a 2051 backstory strand and a 2055 college strand. A single story year cannot represent that. |
| A6 | Section 4 Arc row, PL-2 | Arcs get an owner character and a year range; the outline is a chapter-by-year grid with arc spans. | Arcs in the material are per-character spans across years ("Mark: College Arc", "Siyuan: Motherhood", "Forestory: Kids") drawn on a year axis. |
| A7 | Section 4 Plot beat row | Beats get a point-of-view character, a world context note, and an experience note, and may belong to no arc. | The Sullivan and Li sheets are lists of dated beats with POV, age, "Relevant World Events" and "How the POV Character Experiences This". |
| A8 | Section 4 World event and Era state rows, WE-1 to 3, SB-2 step 2 | Events get a category hierarchy and regions. Decade states become era states with any ranges, seeded from the World Development document's sections. | The High Level sheet files about 250 dated events under 90 category rows (Geopolitics, Technology, Financial Systems, Military, Resources, Demographics, Foreign Relations, Domestic Policy, Cultural Shifts, Second Order Effects). The prose timeline is organized by uneven eras, with 2039 and 2075 as single-year hinges. |
| A9 | Section 4 Character row | Voice notes are year- or age-stamped. | The "Philosophies" section records each character's worldview at a specific age (Frank 65, Laura 41, Sydney 45, Emilie 55, Mark 20/45/72, Qin 78, Siyuan 63, Xuan 43, Dawn 20/45/72). |
| A10 | GL-3 | Chinese characters shown as characters everywhere with hover and keyboard-focus meaning. | Tommy's instruction. |
| A11 | 5.20 TM-1 to 5, M3 | Story Time dialog. | Tommy asked for "some dialog for story time management". Interpretation to confirm: a single place to set the current story year or date, see everyone's ages and the world at that time, and have it drive the tree, timeline, and brief defaults. |
| A12 | IM-1, section 7 | Grid-shaped sheet import. | The High Level sheet is a category-by-year grid, not a table. |
| A13 | IM-7 | Newest source wins on conflicts; every conflict becomes an open question. | Tommy's rule: more recent changes trump older ones, and he will edit through them. |
| A14 | Section 7 fixture | Fixture includes two parts, a two-strand chapter, categories, and a workbook with table and grid sheets. | So the amended model and import paths have tests. |
| A15 | 10.1, NF-4 | Packaging target is macOS only. | Tommy's instruction. |
| A16 | 1, ARCH-8, M0 | The app is general: many bibles, one database each, no book-specific code. East Winds is the first bible and the example. | Tommy: "the supplement tool should be utilizing those details as an example, not purely for this book." |
| A17 | 5.21 DB-1 to 4, ST-1, M7 | Dashboard with Start session: pick a plot section, deterministic selection, Opus synthesizes characters and ages, ongoing world events, and cultural expectations first, then the rest of the brief; logs the session. Per-feature model setting. | Tommy, 2026-10-10: "there should be a way to generate a new session for a given section of plot which synthesizes... this should be on the main dashboard and should use opus." |
| A18 | SB-2 steps 8 and 9, SB-6, section 4 Chapter | Definitions tightened: unresolved beat, linked glossary/theme/question, budget unit and drop order. Every strand carries its own point-of-view character and places; the importer sets a backstory strand's point of view to its first listed character when the sheet gives none, so CC-2 does not flag every backstory strand. | The mockup builder could not implement these rules without choosing; recorded so M7 tests have one reading. |
| A19 | 5.13 AI-1, AI-2, AI-4; ST-1; DB-4; M6 | No chat panel. Claude runs only inside briefs, continuity prose checks, summaries, and import proposals. Claude never drafts prose and no control or setting can ask it to. | Tommy, 2026-10-10: "take out the claude panel, i don't need to ask you questions directly" and "remove any box that will allow claude to draft prose, that should not exist anywhere in the app." |
| A20 | CC-3, CC-4, DB-1, DB-4 | Alignment check: Claude (Opus) reads any chapter or the whole manuscript on demand and compares it to the entries and the stored plot. Each finding resolves as Manuscript wins (one-click prepared change set to the bible, shown as a diff, undoable) or Rewrite recommended (exact lines and what must change, no prose) or Dismiss. Rewrite tasks on the dashboard. | Tommy, 2026-10-10: "allow claude to read the manuscript at any point and check how well it aligns with the plot... either allow me to override what's in the supplement tool and automatically update it, or recommend rewrite on whatever section is misaligned, even showing specific lines. this should use opus too." |
| A21 | 5.13 AI-1, AI-2, AI-4; DB-4; M6 | The question panel is back (read-only tools, proposals only through the queue). The prose ban from A19 stays absolute and now covers the panel: a prose request is declined. | Tommy, 2026-10-10: "add back the claude question panel, that was a good idea." |
| A22 | 1, ARCH-8, 10 | One database only, `novel_companion`; bibles are prefixed collection sets inside it. | Tommy, 2026-10-10: "don't use bible, use novel_companion exclusively." |
| A23 | ARCH-4, 10.2 | API key in the keychain instead of subscription login. | Anthropic's Agent SDK docs forbid claude.ai login for SDK-built products; Tommy supplied an API key on 2026-10-10 and it was verified against the models endpoint. |
| A24 | SB-2 step 9 | Decided open questions are included in the brief and the Relevant to Session view, shown with their decision under their own heading ("Decided"), separate from still-open questions, by the same linking rule as step 9. | Tommy, 2026-10-11: "Decided open questions ARE included in the brief and the Relevant to Session view, shown with their decision under their own heading ("Decided"), separate from still-open questions. Same linking rule as step 9." |
| A25 | SB-6, DB-2 | The three DB-2 lead sections (characters present with ages, world events ongoing at that time, in the window and formative, and cultural expectations) are never dropped by the SB-6 budget. Everything else drops in the SB-6 order first; if the lead three alone exceed the budget, all are kept and the brief says it is over budget. | Tommy, 2026-10-11: "The three DB-2 lead sections ... are never dropped by the SB-6 budget. Everything else drops in the spec's order first; if the lead three alone exceed the budget, keep them all and say the brief is over budget." |
| A26 | FT-8 | The tree fills the panel's visible height (heading, toolbar, and tree share the first screen; legend and warnings follow) and has a full-screen mode for the tree and its inspector. The window grants the `fullscreen` permission and no other. | Tommy, 2026-10-11: "the window for family trees is way too narrow, also make a way to make it full screen." |
| A27 | TM-1, TM-3, DB-2, SB-10 | A top bar on every screen: story year slider and box with the era, a Writing picker over every chapter strand, Start session, and Relevant to Session. Picking a strand sets the story year to its year. | Tommy, 2026-10-11: "put the year slider above everything else, and the 'start a session' too, so it can be changed no matter where you are. i might be anywhere in this wiki when i start a session. also make sure there's a way for me to clarify which chapter i'm writing at the top" and "ensure that when a chapter is picked, that year is auto selected." |
| A28 | SB-10 (new), SB-2 | Relevant to Session: the live SB-2 selection for the chapter being written, from every screen. | Tommy, 2026-10-11: "create a 'Relevant to Session' section that compiles the most important info - world events, characters, story details, cultural expectations - for the chapter being written." |
| A29 | PL-2, section 4 Chapter, IM-1 | Book One's chapters follow the High Level sheet: 48 chapters, 12 per part, each with a present strand (the arc span, primary) and a strand labelled "Backstory: ..." for the non-primary span. Plot v1 rows are plot beats, not chapters. Book Two keeps its Plot v1 rows as chapters until the High Level sheet plans it. A strand that jumps back in story time is labelled backstory. The East Winds Introduction is set in 2078. Applied to the East Winds bible on 2026-10-11; the East Winds default import mapping still maps Plot v1 rows to chapters and must follow this before the next re-import (open). | Tommy, 2026-10-11, answering which plan defines the chapters: "High Level 48-chapter plan"; Introduction year: "2078"; backstory strands: "Yes, label them backstory". |
| A30 | Section 9 | M8 (continuity check) and M10 (settings, performance, packaging, final audit) are built by Tommy separately; the architect does not start them. Withdrawn by A32. | Tommy, 2026-10-11: "don't start m8 or m10, i'll do that separate." |
| A31 | GD-1, GD-4 | Interpretation to confirm: import uses `drive.readonly` (read-only wins over narrowest, since `drive.file` is read-write and blind to files added to a linked folder later); export uses `drive.file` and writes into a folder the app creates, which Tommy can move anywhere. Google Cloud project `novel-companion-511219` with a Desktop OAuth client, in Testing mode with Tommy as test user (weekly re-consent). | Recorded from the M9 build and review, 2026-10-11; Tommy has not yet confirmed the export-folder reading. |
| A32 | Section 9 | A30 is withdrawn. M8 (continuity check) and M10 (settings, performance, packaging, final audit) are built now, as sub agents on Opus, under the section 9 protocol. M10 is split into settings and offline, performance and accessibility and errors, and packaging and journey; the final audit runs after M8 merges. This docs branch and the 2026-10-11 fix round are based on the integration branch `integrate-m6-m7-m9` at f5b7c58 plus the docs commit ab15e2e. | Tommy, 2026-10-11: "m8 and m10 have not been started for the tommymaddenwrites app - first, look through it and audit how well everything matched the spec / arch docs. if there is anything to fix, use sonnet to fix those things, and then start m8 and m10 / any other build steps as sub agents in opus" and later "spin up sub agents for all parts of the app that are not built yet, on opus". |
| A33 | SB-2 step 3, TL-6, ST-1 | The world events window is five years around the story year: three before (the setting, default 3, was 10) through one after. Events of the year after the story year sit under "Planned ahead" (SB-5). The window shows as a strip of year columns with event titles only, each a link to its event; the same strip shows every event on the World events section. | Tommy, 2026-10-12: "why are the world events showing from 2040-2049 when i'm writing in the 2050s? ... just show the main event titles, as links, and only show for five years (so if it's 2051, 2048-2052) ... there should be a timeline view for world events which is shown both for the entire world state and for mini sections like this." |
| A34 | New section 5.22 (KB-1 to KB-8), section 9 M11, TL-2, TL-7, PL-2, TL-6 | The app is reshaped as a knowledge base: a five-screen rail (Characters, Family tree, Outline, Timeline, Entries) with everything else under More; the Story Time dialog is the year view (character states plus the world for the year) and Year view and Compare leave the rail; one Outline edits books, parts, arcs, chapters and beats in place; the Timeline screen is the world with its events and eras editable there; one Entries screen for facts, culture, places, glossary, themes, questions and custom entries; Cmd+K capture files a sentence about the world through Claude proposals approved inline. AI-3 stands: approval moves into the capture box, nothing is written before it. | Tommy, 2026-10-12: "i'm looking for this to be a knowledge base but it's too hard to add knowledge because there's so many dialogs and things. all i care about are 1) characters, 2) year view (which by the way should just show status per character + the world for the year in the top dialog, duh), 3) family tree, 4) outline (just one is fine, make it easy to move around and don't create separate views for parts/arc/strands/whatever), 5) world timeline as a whole (visualized), and then yeah facts / cultural expectations/entries. i should be able to hit a keystroke and just add info about the world which is internalized properly. create sub agents in opus to make all these changes" |
