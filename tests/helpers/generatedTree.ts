/**
 * A generated family tree for the FT-8 and NF-1 performance checks: two
 * founding couples; each couple has three children, two of whom marry
 * someone from outside; the sixth generation has children only. The count
 * caps the last generation, so 200 people span exactly six generations.
 */
type Doc = { _id: string } & Record<string, unknown>;

export function generatedTree(count = 200, gens = 6) {
  const characters: Doc[] = [];
  const unions: Doc[] = [];
  const parentLinks: Doc[] = [];
  let n = 0;
  const time = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  const mk = (born: number, name: string) => {
    const id = `P${String(n).padStart(3, '0')}`;
    characters.push({
      _id: id,
      title: name,
      createdAt: time(n),
      names: { full: name },
      birth: { year: born },
      death: null,
      familyIds: [],
    });
    n += 1;
    return id;
  };
  const marry = (a: string, b: string, year: number) =>
    unions.push({
      _id: `U-${a}-${b}`,
      title: `Union ${a} ${b}`,
      createdAt: time(1000 + unions.length),
      partnerIds: [a, b],
      type: 'married',
      startYear: year,
      endYear: null,
    });
  const link = (parentId: string, childId: string, year: number) =>
    parentLinks.push({
      _id: `L-${parentId}-${childId}`,
      title: `Link ${parentId} ${childId}`,
      createdAt: time(5000 + parentLinks.length),
      parentId,
      childId,
      type: 'biological',
      startYear: year,
    });
  let couples: [string, string][] = [];
  for (let i = 0; i < 2; i++) {
    const a = mk(1900, `Founder ${i + 1}A`);
    const b = mk(1901, `Founder ${i + 1}B`);
    marry(a, b, 1924);
    couples.push([a, b]);
  }
  for (let gen = 1; gen < gens; gen++) {
    const born = 1900 + gen * 25;
    const next: [string, string][] = [];
    for (const [a, b] of couples) {
      for (let k = 0; k < 3 && n < count; k++) {
        const c = mk(born, `Child ${gen}.${n}`);
        link(a, c, born);
        link(b, c, born);
        if (gen < gens - 1 && k < 2 && n < count) {
          const s = mk(born + 1, `Spouse ${gen}.${n}`);
          marry(c, s, born + 24);
          next.push([c, s]);
        }
      }
    }
    couples = next;
  }
  return { characters, unions, parentLinks };
}
