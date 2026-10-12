import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface FoundString {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Module specifiers, regex sources, and type positions are code, not copy. */
function isCode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression.getText() === 'require') return true;
  return false;
}

/**
 * Every string a person could read, from the source of the given folders:
 * string literals, template literal text, and JSX text. Each template is
 * reported whole, with its `${expression}` source in place.
 */
export function userStrings(root: string, folders: string[]): FoundString[] {
  const found: FoundString[] = [];
  for (const folder of folders) {
    for (const file of walk(join(root, folder))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const add = (node: ts.Node, text: string) => {
        if (!text.trim()) return;
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push({ file: relative(root, file), line, text });
      };
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (!isCode(node)) add(node, node.text);
          return;
        }
        if (ts.isTemplateExpression(node)) {
          add(
            node,
            node.head.text +
              node.templateSpans
                .map((s) => '${' + s.expression.getText() + '}' + s.literal.text)
                .join(''),
          );
        } else if (ts.isJsxText(node)) {
          add(node, node.text.replace(/\s+/g, ' '));
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}
