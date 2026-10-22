# fu-culture: Add new on the Cultural data selects, one romanization editor

Read `docs/briefs/FOLLOWUPS-2026-10-22-common.md` first, then SPEC.md IP-1 and IP-8 (section 5.24), GL-1 and ST-1, and `docs/briefs/A47-wave0-api.md` (the `Editable` primitive, `useListAddNew`, `ListSelect`).

What is wrong today:

1. `src/renderer/src/workspace/culture.tsx` around line 335: the Community select on the Communities tab is a plain `<select>` with no "Add new..." option. IP-8: "Every select in the app that chooses a list item has Add new...". There is a separate add control nearby (around line 229, `listAddCommand` on `'communities'`); the select itself must also offer "Add new..." the way `ListSelect` does, creating the community as one undo step and picking it.
2. `culture.tsx` around line 1252 (the Romanization tab, GL-1, A43) and `src/renderer/src/workspace/settings.tsx` around line 81 to 103 (ST-1) each implement the per-language romanization system select, each calling `romanization.get` and `romanization.set` and recording `romanizationCommand`. Two copies of one thing. Neither offers "Add new..." for a system; the tab says "Add or rename systems on the Lists screen" instead.

What to build:

- One component, in a new file beside `culture.tsx` (for example `romanizationSystems.tsx`), that draws the per-language system selects, loads and saves through `romanization.get` and `romanization.set`, records the undo step once, honours read-only (`ro`), and offers "Add new..." on each select that creates the system list item through the same path `ListSelect` uses (`useListAddNew` or `lists.addItem` with `listAddCommand`) and then picks it, all as one undo step. Both `culture.tsx` and `settings.tsx` render this component; their own copies go. Find which list holds romanization systems (look at `romanization.get` in `src/shared/ipc.ts` and the handler in `src/main/ipc/bibleHandlers.ts`) and say in your report if systems are not a list item today; if they are not, "Add new..." on that select is out of scope and you say why.
- The Community select gets "Add new...". Use `ListSelect` if it fits (native select with Add new, one undo step); otherwise add the option by hand in the same style. The existing add control may stay if it does something the select does not (for example naming the community before creating it), or go if it duplicates the select.
- Both themes, keyboard reachable, labels in the primary text colour, no em dashes.

Tests, titles starting with the criterion ID:

- `tests/e2e/knowledge.spec.ts`: "IP-8 the Community select offers Add new, which creates the community as one undo step and picks it" (Cmd+Z removes it and the select goes back); "IP-8 GL-1 the romanization system select on Cultural data offers Add new, and the new system shows in Settings too" (or the reverse direction).
- `tests/e2e/settings.spec.ts`: "ST-1 GL-1 the romanization system saved in Settings shows on the Cultural data Romanization tab" if no row already proves it.
- Keep every existing knowledge and settings row green. Run each file alone, hidden, after `npx electron-vite build`.

Report: the component's props, the tests, and anything you left out with the reason.
