import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

/**
 * ARCH-6: a static map of which IPC handlers in the main process reach a
 * write. The main process is compiled with the TypeScript checker and every
 * call is resolved to the function it names. A function writes when it calls
 * a Repository write method, a MongoDB driver write, or
 * `ClaudeRuntime.runFeature` / `ClaudeRuntime.ask` (which save a run in the
 * bible), or calls a function that writes. A handler is a `'channel.name':`
 * entry of a handler map, or the function given to `handle('channel', ...)`.
 *
 * Calls through an interface (a key store, a settings file, a Drive client)
 * resolve to the interface, not an implementation, so they never count as a
 * bible write; none of those writes the bible.
 */

/** The Repository methods that change the bible (src/main/db/repository.ts). */
export const REPOSITORY_WRITES = new Set([
  'create',
  'createMany',
  'update',
  'writeBatch',
  'softDelete',
  'restore',
  'restoreRevision',
  'renameListItem',
  'addListItem',
  'removeListItem',
  'propose',
  'editProposal',
  'refreshProposal',
  'applyProposal',
  'rejectProposal',
  'applyImport',
  'setSnapshotKeep',
  'saveMapping',
  'setDriveState',
  'setStoryTime',
  'setStrandYear',
  'seedDefaultEras',
  'reorder',
  'setRomanization',
  'setTreePositions',
  'setBriefSettings',
  // a47-model
  'moveListItem',
  'setListItemParent',
  'setListItemLook',
  'setBibleSettings',
  'setEraDefaults',
]);

const DRIVER_WRITES = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'bulkWrite',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'drop',
  'dropDatabase',
  'dropCollection',
  'createCollection',
  'rename',
]);

const RUNTIME_WRITES = new Set(['runFeature', 'ask']);

const CHANNEL = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : /\.ts$/.test(n) ? [p] : [];
  });
}

const isFn = (n: ts.Node | undefined): n is ts.FunctionLikeDeclaration =>
  !!n &&
  (ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n));

function className(n: ts.Node): string | null {
  const c = n.parent;
  return c && ts.isClassDeclaration(c) && c.name ? c.name.text : null;
}

/** The function a declaration stands for: itself, or the function a variable or property holds. */
function fnOf(decl: ts.Declaration): ts.Node | null {
  if (isFn(decl)) return decl;
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && isFn(decl.initializer)) {
    return decl.initializer;
  }
  return null;
}

/** Why a declaration is a write in itself, or null. */
function seedOf(decl: ts.Declaration): string | null {
  const file = decl.getSourceFile().fileName;
  if (!ts.isMethodDeclaration(decl) && !ts.isMethodSignature(decl)) return null;
  const name = decl.name.getText();
  if (file.includes(`${sep}node_modules${sep}mongodb${sep}`) && DRIVER_WRITES.has(name)) {
    return `MongoDB ${name}`;
  }
  const owner = className(decl);
  if (owner === 'Repository' && REPOSITORY_WRITES.has(name)) return `Repository.${name}`;
  if (owner === 'ClaudeRuntime' && RUNTIME_WRITES.has(name)) return `ClaudeRuntime.${name}`;
  return null;
}

/** Each channel handler in src/main mapped to the write it reaches (a short path), or null. */
export function handlerWrites(mainDir: string): Map<string, string | null> {
  const program = ts.createProgram(tsFiles(mainDir), {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    types: ['node'],
  });
  const checker = program.getTypeChecker();
  const mine = program
    .getSourceFiles()
    .filter((sf) => sf.fileName.startsWith(mainDir) && !sf.isDeclarationFile);

  /** Calls made by each function body (by the function node), and seeds reached directly. */
  const edges = new Map<ts.Node, Set<ts.Node>>();
  const direct = new Map<ts.Node, string>();
  const handlers = new Map<string, ts.Node[]>();

  const target = (e: ts.Expression): ts.Declaration | null => {
    let s = checker.getSymbolAtLocation(ts.isCallExpression(e) ? e.expression : e);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s?.declarations?.[0] ?? null;
  };

  const owners: ts.Node[] = [];
  const note = (decl: ts.Declaration | null) => {
    const owner = owners.at(-1);
    if (!decl || !owner) return;
    const seed = seedOf(decl);
    if (seed && !direct.has(owner)) direct.set(owner, seed);
    const fn = fnOf(decl);
    if (fn) {
      if (!edges.has(owner)) edges.set(owner, new Set());
      edges.get(owner)!.add(fn);
    }
  };

  const visit = (node: ts.Node): void => {
    // A handler entry: `'entry.create': async (...) => ...`.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      CHANNEL.test(node.name.text)
    ) {
      handlers.set(node.name.text, [...(handlers.get(node.name.text) ?? []), node.initializer]);
    }
    // `handle('bible.create', guard('bible.create', (req) => ...))`.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'handle' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[1]
    ) {
      const ch = node.arguments[0].text;
      handlers.set(ch, [...(handlers.get(ch) ?? []), node.arguments[1]]);
    }
    // Calls are credited to the innermost function, or to the handler entry they sit in.
    const isOwner = isFn(node) || (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name));
    if (isOwner) owners.push(node);
    if (ts.isCallExpression(node)) note(target(node));
    else if (
      ts.isIdentifier(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.includes(node)
    ) {
      // A function passed along, as in `.then(save)`, counts as called.
      note(target(node));
    }
    // A nested function's calls are its own; the enclosing function calls it.
    if (isFn(node) && owners.length > 1) {
      const parent = owners.at(-2)!;
      if (!edges.has(parent)) edges.set(parent, new Set());
      edges.get(parent)!.add(node);
    }
    ts.forEachChild(node, visit);
    if (isOwner) owners.pop();
  };
  for (const sf of mine) visit(sf);

  const reason = new Map<ts.Node, string>(direct);
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, tos] of edges) {
      if (reason.has(from)) continue;
      for (const to of tos) {
        const r = reason.get(to);
        if (r) {
          const label = nameFor(to);
          reason.set(from, label ? `${label} > ${r}` : r);
          changed = true;
          break;
        }
      }
    }
  }

  const out = new Map<string, string | null>();
  for (const [ch, nodes] of handlers) {
    const hit = nodes
      .map((n) => reason.get(n) ?? reason.get(n.parent) ?? reachFrom(n, reason))
      .find(Boolean);
    out.set(ch, hit ?? null);
  }
  return out;
}

function reachFrom(n: ts.Node, reason: Map<ts.Node, string>): string | null {
  let found: string | null = null;
  const walk = (x: ts.Node) => {
    if (found) return;
    const r = reason.get(x);
    if (r) {
      found = r;
      return;
    }
    ts.forEachChild(x, walk);
  };
  walk(n);
  return found;
}

function nameFor(n: ts.Node): string | null {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n.name?.getText() ?? null;
  const p = n.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))) return p.name.getText();
  return null;
}
