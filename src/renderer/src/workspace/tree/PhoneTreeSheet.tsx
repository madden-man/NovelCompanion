import { lifeState, lifeYears } from '../../../../shared/domain/ages';
import type { LifeState } from '../../../../shared/domain/ages';
import { hasBranch, relativesOf } from '../../../../shared/domain/tree';
import type { TreeGraph } from '../../../../shared/domain/tree';
import type { Response } from '../../../../shared/ipc';
import { useBibleSettings } from '../bibleSettings';
import { PhoneSheet } from '../phone/Sheet';

type Warnings = Response<'tree.get'>['warnings'];

function stateLine(s: LifeState, year: number): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear
        ? `In ${year}: age ${s.age}, dies this year`
        : `In ${year}: age ${s.age}`;
    case 'dead':
      return `In ${year}: dead since ${s.deathYear}`;
    case 'unborn':
      return `In ${year}: not yet born`;
    case 'unknown':
      return `In ${year}: age unknown`;
  }
}

/**
 * A58 U4 (PH-33): what the desk's tree inspector shows, as the phone's bottom
 * sheet: the person's name, years and state in the story year, their links
 * from the top down, and Open. With nobody selected it holds the warnings.
 * Adding people or links, and changing a link, stay on the desk.
 */
export function PhoneTreeSheet(props: {
  graph: TreeGraph;
  selected: string | null;
  year: number;
  hint: (id: string) => string;
  collapsed: boolean;
  warnings: Warnings;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { graph, selected, year } = props;
  const person = selected ? graph.byId.get(selected) : undefined;
  const name = (id: string) => graph.byId.get(id)?.name ?? id;
  const labels = useBibleSettings().templates.linkTypeLabels;
  const label = (t: string) => labels[t] ?? t;
  if (!person) {
    return (
      <PhoneSheet name="tree" label="Warnings" title testId="tree-sheet">
        {props.warnings.length === 0 ? (
          <p className="ph-sheet-note">No warnings</p>
        ) : (
          <ul className="ph-list ph-tree-warnings" data-testid="tree-warnings">
            {props.warnings.map((w, i) => (
              <li key={i}>
                <p className="ph-tree-warning">{w.message}</p>
                {w.personIds[0] && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => props.onSelect(w.personIds[0] ?? null)}
                  >
                    Show {name(w.personIds[0])}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PhoneSheet>
    );
  }
  const years = lifeYears(person);
  const rel = relativesOf(graph, person.id);
  const since = (type: string, start: number | null) =>
    start !== null && type !== 'biological' ? `${label(type)}, from ${start}` : label(type);
  const groups = [
    {
      kind: 'parent',
      title: 'Parents',
      rows: rel.parents.map((p) => ({ id: p.id, detail: since(p.type, p.startYear) })),
    },
    {
      kind: 'partner',
      title: 'Partners',
      rows: rel.partners.map((p) => ({
        id: p.id,
        detail:
          p.startYear === null && p.endYear === null
            ? label(p.type)
            : `${label(p.type)}, ${p.startYear ?? '?'} to ${p.endYear ?? 'now'}`,
      })),
    },
    {
      kind: 'sibling',
      title: 'Siblings',
      rows: rel.siblings.map((s) => ({ id: s.id, detail: s.kind === 'half' ? 'half' : '' })),
    },
    {
      kind: 'child',
      title: 'Children',
      rows: rel.children.map((c) => ({ id: c.id, detail: since(c.type, c.startYear) })),
    },
  ].filter((g) => g.rows.length > 0);
  const hint = props.hint(person.id);
  return (
    <PhoneSheet name="tree" label={person.name} title testId="tree-sheet">
      <div className="ph-tree-person" data-person={person.id}>
        <p className="ph-tree-years" data-testid="tree-sheet-years">
          {person.chinese && <span className="ph-tree-zh">{person.chinese} </span>}
          {years === 'unknown' ? 'born ?' : years}
        </p>
        <p className="ph-sheet-note" data-testid="tree-sheet-state">
          {stateLine(lifeState(person, year), year)}
        </p>
        {hint && <p className="ph-sheet-note">{hint}</p>}
        <div className="ph-tree-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => props.onOpen(person.id)}
            data-testid="tree-sheet-open"
          >
            Open
          </button>
          {hasBranch(graph, person.id) && (
            <button type="button" className="btn" onClick={() => props.onToggle(person.id)}>
              {props.collapsed ? 'Expand branch' : 'Collapse branch'}
            </button>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="ph-sheet-note">No family links</p>
        ) : (
          groups.map((g) => (
            <section key={g.kind} data-group={g.kind} aria-label={g.title}>
              <h3 className="ph-group">{g.title}</h3>
              <ul className="ph-list" data-testid="tree-sheet-links">
                {g.rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="ph-row ph-tree-rel"
                      onClick={() => props.onSelect(r.id)}
                    >
                      <span>{name(r.id)}</span>
                      {r.detail && <span className="ph-tree-detail">{r.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </PhoneSheet>
  );
}
