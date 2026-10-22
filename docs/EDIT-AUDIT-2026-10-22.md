# Edit audit, 2026-10-22

Source: the audit artifact (Novel Companion Edit Audit) read at commit 3671b2b. The renderer, shared and main source were read screen by screen; every row cites a file and line at that commit. Grades: In place (click it, change it, undo it), Elsewhere (shown here, edited on another page), Locked (shown here, no edit path from here), Hidden (stored, but not reachable from this screen), Derived (computed, correctly not editable). The recommendations became SPEC section 5.24 (A47, IP-1 to IP-18).

Totals: 49 in place, 24 elsewhere, 25 locked, 11 hidden, 8 derived (117 rows).

## Relevant to Session (15 items: 3 in place, 4 elsewhere, 6 locked, 2 hidden)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Chapter title heading | Locked | Plain heading. Rename on the Outline bar or the chapter page. | `relevantBody.tsx:535-540` |
| Story year chip, point of view name | Locked | Strand year and point of view live on the chapter page under Strands. | `relevantBody.tsx:541-543` |
| What happens in this scene | In place | Rich text, autosaves, one undo step per pause. | `relevantBody.tsx:255-275` |
| Character tile: name, Chinese name, age | Locked | Opens via the "Their page" button inside the expanded tile. | `relevantBody.tsx:118-139` |
| Tile: In the story, Description | Locked | Drawn with the read-only Markdown view. | `relevantBody.tsx:143-152` |
| Tile: family line | Locked | Not a link. Edit in the tree. | `relevantBody.tsx:153` |
| Tile: latest moments | Locked | Plain text, not even clickable. Edit on Backstory. | `relevantBody.tsx:155-178` |
| Who is present in the scene | Hidden | Only the chapter page's Strands editor adds or removes people. | `Strands.tsx:183-254` |
| World events strip | Elsewhere | Title opens the event page. No "add an event" here. | `common.tsx:150-184` |
| Cultural context: the strand's places | In place | Change places, multi-select, Save. One undo step. | `relevantBody.tsx:316-376` |
| Cultural lines | Elsewhere | Click opens the entry. The gap button hands the text to Claude capture, no plain "write it" path. | `relevantBody.tsx:377-425` |
| Backstory rows | Elsewhere | Opens the moment page. | `relevantBody.tsx:278-333` |
| More: planned ahead, places, glossary, questions, previous chapters, last note | Elsewhere | Each opens its page. Raw IDs are printed beside titles. | `common.tsx:44-70` |
| Add or remove entries from the selection (SB-9) | Hidden | Only on a saved brief, after generating. | `brief.tsx:210-268` |
| Brief window and size budget | In place | Number inputs, undoable. | `relevant.tsx:90-163` |

## Characters (10 items: 5 in place, 2 elsewhere, 2 hidden, 1 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Full name, Chinese name | In place | Behind an "Edit name" button, then Done. Two steps for a rename. | `character.tsx:335-382` |
| Birth, Death | In place | One text box each, saves on blur or Enter, explains what it could not read. | `character.tsx:67-137` |
| Status | In place | Select. | `character.tsx:403` |
| Families | In place | Chips with remove, Add family select. | `character.tsx:179-247` |
| Age at the story year | Derived | From birth and story time. | `character.tsx:143-160` |
| Relatives line | Elsewhere | Read-only sentence that opens the tree. | `character.tsx:415-425` |
| In the story, Description, Backstory | In place | Rich text boxes that grow. | `character.tsx:429-434` |
| Moments | Hidden | Not on the page. Backstory screen only. | `SM-1` |
| Provenance, source note, tags, links | Hidden | Stored, not shown on the page (by spec SM-1). | `character.tsx` |
| Character list rows | Elsewhere | Click opens the page. No inline rename, no quick add with a name. | `views.tsx:137` |

## Family tree (8 items: 4 in place, 2 elsewhere, 1 hidden, 1 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Inspector: name, Chinese, In the story, Description, Birth, Death, Families | In place | Fields in the inspector, autosave. | `TreeView.tsx:1115-1222` |
| Backstory | Elsewhere | "Open in Backstory" link. | `TreeView.tsx:1214-1219` |
| Union and parent link type | In place | Select, saves at once with undo. | `TreeView.tsx:1435-1452` |
| Union years, how it ended, link start year | In place | "Edit" swaps the generic editor into the inspector. Two clicks. | `TreeView.tsx:1055-1065` |
| Siblings | Derived | From shared parents. | `TreeView.tsx:1504-1509` |
| Family names and colours (legend) | Elsewhere | Families page via Search, or the Lists screen. Four fixed "Color N" tokens. | `TreeView.tsx:904-967, family.ts:21-25` |
| Person position | In place | Drag, or Alt with arrows. | `FT-11` |
| Status, provenance, tags, links | Hidden | Not in the inspector. | `TreeView.tsx:1112-1113` |

## Outline (14 items: 8 in place, 2 elsewhere, 2 hidden, 2 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Scene text | In place | Textarea, autosave within 700 ms. Typing is not an app undo step. | `Scenes.tsx:333-352` |
| Scene year, set | In place | Input, blur or Enter, one undo step. | `Scenes.tsx:1540-1612` |
| Scene year, inherited | Derived | Nearest scene above, else the chapter year. | `sceneOutline.ts:455-466` |
| Chapter title on the bar | In place | Click, type, Enter. | `Scenes.tsx:1337-1346` |
| Chapter year on the bar | In place | Writes the primary strand's start year and shifts its end. | `Scenes.tsx:1278-1293` |
| Ch number | Derived | Reading order. Move the bar to change it. | `Scenes.tsx:1336` |
| Chapter order, section edges | In place | Drag or arrows, one undo step each. | `Scenes.tsx:1295-1305` |
| Divider (part) title | In place | The first part has no divider, so its title is never shown or renamable here. | `Scenes.tsx:1196-1207, 1010` |
| Part number and summary, Books | Hidden | Only via Search, Section, "List every part". | `Workspace.tsx:268` |
| Strands: label, point of view, characters present, places, backstory year | Elsewhere | "Open" to the chapter page. | `Strands.tsx:34-98` |
| Written flag, summary, scene note | Elsewhere | Chapter page. | `story.ts:90-103` |
| Eras and world events beside chapters (PL-6) | Hidden | The hook exists and is unused. Nothing is drawn. | `world.ts:15` |
| Delete a chapter | In place | Drop on the trash or press Delete. No confirmation, undo restores. | `Scenes.tsx:966-975` |
| Versions | In place | Restore is one undo step. | `Scenes.tsx:1626-1736` |

## World events (9 items: 2 in place, 4 elsewhere, 2 locked, 1 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Event year span | In place | Drag or arrows, one undo step. | `gridShared.tsx:196-233` |
| New event | In place | Click an empty spot: title, year, end, formative. Nothing else. | `WorldEventsGrid.tsx:249-356` |
| Event title, body, regions, characters affected, category, status | Elsewhere | Editor opens under the grid on one click. | `TimelineView.tsx:374-381` |
| Category groups and rows | Elsewhere | Lists screen. No reorder, no re-parent anywhere. | `views.tsx:405-530` |
| Regions filter chips | Derived | From what events use. No regions list to manage. | `TimelineView.tsx:75-78` |
| Era band | Elsewhere | Click opens the era editor. No create, drag or resize. | `gridShared.tsx:402-429` |
| Year axis 2025 to 2100 | Locked | Hardcoded, grows to fit, never narrows. | `worldGrid.ts:11-12` |
| Story year line, chapter band | Elsewhere | Story time dialog. | `gridShared.tsx:517-534` |
| "World around" window, 3 back and 1 ahead | Locked | Hardcoded on this screen. | `worldGrid.ts:520-521` |

## Backstory (10 items: 4 in place, 1 elsewhere, 3 locked, 1 hidden, 1 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Moment year span on the grid | In place | Drag or arrows. | `BackstoryView.tsx:207-238` |
| New moment | In place | One click creates it, focus lands in "What happens". | `BackstoryView.tsx:139-160` |
| Moments table: year, to, what happens, how they experience it, world events | In place | Each cell saves on blur or Enter, one undo step. | `MomentsTable.tsx:155-208` |
| Moment's character | Locked | A moment cannot move to another person. | `MomentsTable.tsx` |
| Moment status, tags, links | Hidden | Generic page only. | `moment.ts` |
| Lifespan bar (birth, death) | Locked | Not draggable. Edit on the character page. | `BackstoryGrid.tsx:186-225` |
| Character name row | Locked | Click only picks the person. No link to the page. | `BackstoryGrid.tsx:143-156` |
| Family grouping and order | Derived | Tree positions. First family wins. | `backstoryGrid.ts:105-161` |
| Era band | Elsewhere | Click leaves the screen to the era page. | `BackstoryGrid.tsx:98-104` |
| "Pick events" in world context | In place | Adds the title as text, not a link. Reach is one year. | `backstoryGrid.ts:389-414` |

## Story time dialog (7 items: 2 in place, 1 elsewhere, 4 locked)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Year, month, day, plus and minus | In place | Writes bible meta only. | `StoryTimeDialog.tsx:272-349` |
| Everyone's state and age table | Locked | No row links. Birth, death, family not editable. | `StoryTimeDialog.tsx:499-531` |
| Era panel (name, span, body) | Locked | Not a link. | `StoryTimeDialog.tsx:535-553` |
| Events strip | Elsewhere | Opens the event page. | `StoryTimeDialog.tsx:554-565` |
| Chapter strands in the year | Locked | Plain text. | `StoryTimeDialog.tsx:566-580` |
| Use year as strand year | In place | Diff preview then Approve, one undo step. | `StoryTimeDialog.tsx:191-237` |
| Lived through, Compare | Locked | Read-only rows. | `LivedThrough.tsx:13-95, CompareView.tsx:30-149` |

## Cultural data (11 items: 5 in place, 2 elsewhere, 2 locked, 2 derived)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Community name, add, remove | In place | Undoable, remove confirms once. | `culture.tsx:285-347` |
| Community description | In place | Rich text, undoable. | `culture.tsx:403-409` |
| Decade shown | Locked | Follows the story year only. No decade control on the screen. | `culture.tsx:140, 279-281` |
| Line text, age group, decade | In place | Blur or Enter. Decade is a select of whole decades only. | `culture.tsx:597-652` |
| Line note | In place | Only when a note already exists. Cannot add one here. | `culture.tsx:588, 663` |
| Line year range beyond a decade | Elsewhere | Generic page, "Applies from" and "Applies to". | `world.ts:78-81` |
| Age groups (six bands) | Locked | Fixed enum. | `world.ts:53-63` |
| Line order | Derived | Start year, then title. | `culture.ts:88-92` |
| Eras tab: name, start, end, description | In place | Each a step. | `culture.tsx:846-905` |
| Eras listed | Derived | Only eras covering the story year. | `culture.tsx:692-712` |
| Delete an era | Elsewhere | Trash on the generic page. | `culture.tsx:684-909` |

## Sessions (9 items: 5 in place, 2 elsewhere, 1 locked, 1 hidden)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Where you stopped panel | Elsewhere | Edit in the log row below. | `SessionsView.tsx:172-195` |
| Start session inputs | In place | Chapter, strand, part, year and point of view, places, others present. | `start.tsx:139-226` |
| Selection preview before generating | Elsewhere | Items open pages. No remove before generating. | `start.tsx:263-276` |
| Brief text | In place | "Edit the text" then a textarea. Regenerate overwrites edits without warning. | `brief.tsx:160-201, sessionHandlers.ts:280` |
| Brief selection add and remove | In place | Remove, Keep and a picker. The pending list shows raw IDs. | `brief.tsx:210-268` |
| Session log row | In place | Opens the full editor in place. | `SessionsView.tsx:264-314` |
| New log entry by hand | Hidden | Only Start session or the stop prompt create one. | `sessionHandlers.ts:250` |
| Open questions | In place | Editor in place, links included. The list shows the title, not the question. | `SessionsView.tsx:423-447` |
| Rewrite tasks | Locked | Text read-only. Done and Open chapter only. | `alignment.tsx:558-635` |

## Continuity checker (8 items: 4 in place, 2 elsewhere, 2 locked)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Finding text, quote, what must change | Locked | The card has no link. Editable only via Search, Findings. | `alignment.tsx:338-377` |
| Resolutions | In place | Undoable. No resolution note here. | `alignment.tsx:283-315` |
| Change set | Locked | System field. Apply all or nothing. | `story.ts:283` |
| Manuscript text | Elsewhere | Not shown here. Editable as a plain field on the chapter page although MS-5 says read-only. | `story.ts:91, manifest.ts:181` |
| Written flag | In place | "Mark as written" only. Unmark on the chapter page. | `manuscript.tsx:196-204` |
| Summary before approval | In place | Rich text draft. | `manuscript.tsx:287-294` |
| Summary after approval | Elsewhere | Chapter page only. | `manuscript.tsx:379-383` |
| Promote planned to canon | In place | Checkbox list, undoable. | `manuscript.tsx:386-436` |

## Lists and Settings (7 items: 3 in place, 1 elsewhere, 2 locked, 1 hidden)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Union types, parent link types, communities, event categories, romanization systems, languages, tags | In place | Rename, add, remove if unused. No reorder, no re-parent. | `views.tsx:405-598` |
| Statuses, provenance | Locked | Rename is stored and nothing reads it. Enums fixed in code. | `manifest.ts:148-157` |
| Families, era ranges | In place | Rename only. The range is read-only here. | `repository.ts:712` |
| Era defaults for a new bible | Hidden | No screen. A migration constant. | `003-era-defaults.ts:11-24` |
| Family colour | Elsewhere | Families page, four tokens. | `family.ts:21-25` |
| Romanization per language, snapshot count, brief window and budget, model per feature | In place | Settings. | `settings.tsx:70-233, 483-488` |
| Claude instructions per feature | Locked | In code. | `briefs.ts:66, summaries.ts:22, alignment.ts:27` |

## Capture, Review, Claude, Trash (9 items: 4 in place, 1 elsewhere, 3 locked, 1 hidden)

| Content shown | Grade | How it is edited today | Evidence |
|---|---|---|---|
| Capture proposals | In place | Tick or untick only. Values are not editable in the box. | `capture.tsx:681-703` |
| Review queue proposal | In place | Edit the fields a create or update already carries. Cannot add a field. | `review.tsx:141-182` |
| Capture to a new community or category | Locked | Claude cannot add list items. | `capture.ts:46-50` |
| Capture to the scene outline or one strand | Locked | Meta document, or the whole strands array only. | `repository.ts:1548` |
| Claude conversations | Locked | No rename, delete or clear. | `shared/claude.ts:294-308` |
| Trash: delete forever, empty trash | Hidden | No path exists. | `views.tsx:315-402` |
| History revisions | In place | Compare and restore with undo. Cannot delete revisions. | `history.tsx:47-206` |
| Raw section lists (16 collections) | Elsewhere | Only via Search, Section, "List every X". No rail or menu item. | `search.tsx:117-135` |
| Add to glossary from Chinese text | In place | Headings and long-text previews only. Not lists, tree nodes or text fields. | `Zh.tsx:92-114` |

## Cross-cutting gaps

- Undo has holes: typing in the scene outline is not an undo step (Scenes.tsx:333-352 vs :358-369); regenerating a brief overwrites hand edits with no warning (sessionHandlers.ts:280); deleting a chapter from the outline needs no confirmation (Scenes.tsx:966-975), undo covers it.
- The vocabulary is fixed in code: statuses and provenance are enums (manifest.ts:148-157) and the Lists screen rename is read by nothing; age groups are six bands (world.ts:53-63); the decade is the only cultural time unit (culture.ts:39-48); the year axis 2025 to 2100 (worldGrid.ts:11-12), the world-around window 3 back and 1 ahead (worldGrid.ts:520-521), the moment event picker reach of 1 year (backstoryGrid.ts:389); lists cannot be reordered or re-parented (ipc.ts:734-759); regions have no list; family colours are four tokens (family.ts:21-25); era defaults are a migration constant (003-era-defaults.ts:11-24); default titles and labels are literals; Claude's instructions per feature live in code (briefs.ts:66, summaries.ts:22, alignment.ts:27, prompts.ts).
- Reachability: sixteen of seventeen collections have no list in the rail or App menu (search.tsx:117-135); characters present in a scene are edited only in the chapter page's Strands editor (Strands.tsx:183-254); findings on the Continuity card do not link to the finding (alignment.tsx:338-377); the first part's title never appears on the Outline (Scenes.tsx:1010).
- Housekeeping nobody can do: no delete forever, no empty trash (views.tsx:315-402); Claude conversations cannot be renamed, cleared or deleted (shared/claude.ts:294-308); revisions cannot be pruned; a cultural line cannot gain a note on the Cultural data screen (culture.tsx:588, 663).

## The manuscript decision

The spec (MS-5, IM-4) says the manuscript text is a read-only import because line numbers and dismissed-finding hashes come from it, yet the chapter page shows it as an ordinary editable box (story.ts:91, manifest.ts:181) and Claude can propose changes to it. Decided for A47: lock the field, show it read-only with Re-import beside it, and make re-import one click from Relevant to Session (IP-18).

## Not covered

The importer's mapping screen, Google Drive and Backups move whole files, not story content. Writing tools stores nothing.
