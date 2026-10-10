# Build prompt: novel companion desktop app

## What I'm asking for

Build me a desktop application that acts as a writing companion for a novel I'm writing. I am the only user. The app holds everything I know about the book's world, and its main job is to hand me a focused brief before each writing session, based on where I am in the book.

You are the architect. You plan, write the spec, delegate implementation to subagents running on Opus (`model: opus`), and verify every piece they build before moving on. Do not write most of the code yourself; your context is better spent on design and verification.

## The book

- A multi-generational novel set from 2025 to 2100.
- Two parallel families: the Sullivans and the Lis.
- Settings: San Francisco, and Guangdong, China.
- My existing material is in `./source-material/` [I'll copy it there from Google Drive before starting]: an Excel workbook of perspectives on the world I'm developing, and Word documents with character backstories. The originals live in Google Drive.

## Phase 0: read, interview, spec (no code yet)

1. Read everything in `./source-material/`. Tell me what you found: characters, events, places, themes, gaps, and anything contradictory.
2. Ask me the questions you need answered. At minimum: my operating system, where I write the manuscript itself (I currently assume I keep writing in Word or Google Docs and the app does not replace my editor), and how I want to authenticate Claude inside the app.
3. Read `SPEC.md` in this folder. It was written before anyone had seen my source material, and it is the authority for this project: where it and this prompt differ, the spec wins. Reconcile it with what you found: answer the decisions in its section 10, propose amendments where my real material does not fit its data model or where a criterion is not concrete enough to test, and record them in its amendments log.
4. Stop and wait for my approval of the amended `SPEC.md` before building. After that, do not change the spec to make a failing criterion pass; ask me instead.

## Architecture defaults (change them in the spec if you have a better reason)

- Electron, TypeScript, React, and a local SQLite database. I chose this so Claude can run inside the app through the Claude Agent SDK or the Anthropic API from the Node side. Check the current Anthropic documentation for the SDK and model names rather than relying on memory.
- The local database is the source of truth. Google Drive is an import source and a backup target, not a two-way sync. Two-way sync creates conflicts that are not worth it for one user.
- Google Drive: OAuth with read-only scope for import. I pick which files and folders to import, and re-import shows me a diff before changing anything. A separate, explicit action exports the whole story bible to a Drive folder as Markdown and JSON.
- Creating the Google Cloud OAuth client is a step I have to do by hand. Give me exact instructions when you reach it, and build everything else so it works without Drive connected.
- Secrets go in the operating system keychain, never in the repository or the database.
- Automatic local snapshots of the database, so I can roll back.

## What the app holds

Every entry has a status of **canon** (established in a written chapter), **planned**, or **idea**, and can be tagged **researched** (with a source) or **invented**.

1. **Plot**: the overall book arc, plus separate arcs for the Sullivan and Li families, broken into chapters or scenes, each with a story year and point-of-view character.
2. **Characters**: birth and death years, family, backstory, voice notes (how they speak, what they would never say).
3. **Family trees and relationships**: both lineages, and where the families intersect.
4. **World events, 2025 to 2100**: real and invented, each dated.
5. **World state by decade**: technology, climate, economy, politics, and everyday details, so the future stays consistent.
6. **Cultural traditions and expectations**: for San Francisco and for Guangdong, including how they shift across generations.
7. **Places**: locations and how they change over time.
8. **Glossary**: Cantonese and Mandarin terms, one romanization system, naming conventions.
9. **Knowledge states**: who knows which secret or piece of family history, and from when.
10. **Themes and motifs**: and where each has appeared.
11. **Manuscript chapters**: imported from Drive, each with a summary generated after I write it and approved by me.
12. **Open questions and a session log**: unresolved decisions, and where I stopped last time.

Leave room for more sections; I will add some.

## What the app does

- **Timeline and ages.** For any year, show who is alive, how old they are, and which world events they have lived through. This must be computed in ordinary code, never by asking a model, because it has to be exactly right.
- **Session brief.** I give it a chapter, or a year and point-of-view character. It returns one page: who is present and their ages, what has happened to them so far, relevant world state and events, relevant cultural context, who knows what, loose threads, and open questions. Selection of entries is done by deterministic queries; Claude only synthesizes what was selected. The brief lists the entries it drew from, and keeps canon separate from planned material.
- **Continuity check.** Compare a chapter against the story bible and flag contradictions (ages, dates, who knew what, established facts), citing both sides.
- **Claude panel.** A chat with Claude inside the app that can search and read the story bible through tools. Claude may propose additions or edits to entries, but nothing is saved until I approve it. Claude does not draft prose for the novel unless I ask.
- **Editing.** Every section is easy to edit by hand, with search and cross-links between entries.

## How to build it

Work through the milestones in `SPEC.md` one at a time. For each:

1. Give an Opus subagent the relevant spec section, its acceptance criteria, and the files it may touch. It writes the code and the tests.
2. Run the full test suite yourself. Do not accept a subagent's report that tests pass.
3. Have a separate subagent with fresh context review the work against the acceptance criteria, one criterion at a time, and report pass or fail with evidence. It should not see the builder's explanation, only the spec and the code.
4. If anything fails, send it back with the specific failure and repeat from step 2.
5. When everything passes, update `PROGRESS.md` (criterion, status, how it was verified) and commit.

Do not start a milestone while an earlier one has failing criteria.

## Tests

- **Unit tests** for all deterministic logic, especially ages, timeline queries, and brief selection.
- **Integration tests** for: importing Excel and Word files into the data model, the Drive import and export flow (against a mocked Drive with fixture files), brief generation end to end, the continuity check, and the approve-before-save flow for Claude's proposed edits.
- **Claude calls** are mocked with recorded responses in the main suite, with a small separate live smoke test I can run on demand.
- **End-to-end tests** that launch the real app and drive the main flows through the interface.
- Build a small fixture novel (two families, a dozen characters, events across 75 years, a few deliberate contradictions) so tests do not depend on my real material and the continuity check has known answers.

## When you finish

Run the whole suite one last time, walk every acceptance criterion in `SPEC.md`, and give me: what is built, anything that does not meet spec and why, how to run the app, and the manual steps left for me. If you had to choose between two reasonable readings of anything here, tell me which you chose.
