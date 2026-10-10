/** Small helpers for dotted field paths such as `names.full` or `voiceNotes.0.at`. */

export type Doc = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Doc {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isPlainObject(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

export function joinPath(base: string, key: string | number): string {
  return base ? `${base}.${key}` : String(key);
}

/** Deep equality for plain JSON values. Key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
