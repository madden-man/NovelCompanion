# Progress

One row per criterion. Status: `pass`, `fail`, `pending`. Evidence names the test and what it asserts, or a recorded manual check.

## Phase 0

| Item | Status | Evidence |
|---|---|---|
| Source material read | pass | `docs/PHASE0-FINDINGS.md`, 2026-10-10 |
| Spec amended and approved | pass | `SPEC.md` v0.2, A1 to A16; Tommy confirmed decisions 2026-10-10 |
| MongoDB reachable | pass | Manual: ping, write and delete on the cluster from this Mac, 2026-10-10 |
| Claude Code CLI signed in | pass | Manual: `claude auth status` reports claude.ai login, 2026-10-10 |

## M0: scaffold, test harness, fixture novel

| Criterion | Status | Evidence |
|---|---|---|
| ARCH-1 | pass | `tests/e2e/app.spec.ts` "ARCH-1 the renderer is sandboxed with no Node integration" (nodeIntegration false, contextIsolation true, sandbox true; `require`, `process`, `module` undefined; `window.api` exposes only invoke and on), "ARCH-1 the Content-Security-Policy forbids remote scripts and remote connections" (remote fetch and remote script both blocked), "ARCH-1 app.ping round-trips through window.api", "ARCH-1 window.api refuses to open a link to a host that is not allowlisted"; `tests/unit/ipc-contract.test.ts` and `tests/unit/preload.test.ts` validate both sides of every channel; `tests/unit/links.test.ts` "ARCH-1 every other link is refused". Reviewed independently 2026-10-10. |
| ARCH-2 | pass | `tests/integration/bibles.test.ts` "ARCH-2 migrate runs pending migrations in order and records the version on the registry", "refuses a bible from a newer app"; `tests/integration/search.test.ts` "ARCH-2 a Chinese title 晓曦 is found by 晓曦 and by 曦 right after the write"; `tests/unit/search.test.ts` bigram tokenizer; `tests/integration/repository.test.ts` read model loads every collection. |
| ARCH-7 | pass | `tests/unit/telemetry.test.ts` "ARCH-7 no installed package in the lockfile is a telemetry package", "no source file references a telemetry service or the crash reporter". |
| ARCH-8 | pass | `tests/integration/bibles.test.ts` "ARCH-8 connect selects the novel_companion database", "two bibles in the same database do not see each other data", "dropping a bible drops only its prefixed collections"; `tests/unit/single-database.test.ts` (no `listDatabases`, no other `.db(`); `tests/e2e/app.spec.ts` "ARCH-8 a bible created through window.api appears in bible.list and in the window", "opening a bible makes it current and shows its name in the window", "a second bible made with the New bible form can be switched to", "creating a bible with a bad or duplicate ID fails with a plain message". First review failed (create and switch unreachable); fixed and re-reviewed pass 2026-10-10. |
| Section 7 fixture | pass | `tests/unit/fixture.test.ts` "Section 7 the people table is in the fixture exactly as written", "unions and parent links match the people table", "planted structural errors S1, S2, S3 are present as data", "planted prose errors P1 and P2 are present in chapter text", "expected TL-2 answers match the spec text", two-strand chapter, categories, workbook with table and grid sheet, docx with heading and italic. Reviewer confirmed by hand that `fixtures/expected/` is written by no code. |
| T-7 | pass | `npm test` runs lint, typecheck, unit (61), integration (19), e2e (12) in order and stops on the first failure; `tests/unit/harness.test.ts`; run by the architect and by the reviewer, exit 0. |

Open notes from review (carried into M1): close the MongoClient when `connect()` throws; e2e MongoMemoryServer must be a replica set before any e2e test writes entries; add unit cases for the bible.create, bible.open, bible.current schemas.

## M1: data model, generic editing, history, undo, trash, links

| Criterion | Status | Evidence |
|---|---|---|
| ED-1 | pending | |
| ED-2 | pending | |
| ED-3 | pending | |
| ED-4 | pending | |
| ED-5 | pending | |
| ED-6 | pending | |
| ED-7 | pending | |
| ED-8 | pending | |
| ED-9 | pending | |
| ED-10 | pending | |
| T-5 | pending | |
