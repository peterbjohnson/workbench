import ts from 'typescript';

import type { CodeSymbol, Reference } from './symbols.ts';

export type Inside = { symbols: CodeSymbol[]; references: Reference[] };

/**
 * What is in a JavaScript file, from the TypeScript compiler's parser.
 *
 * `ts.createSourceFile` parses and nothing else — no program, no type checker, no
 * `tsconfig` — so it is fast, it never touches the filesystem, and it is already
 * installed. It also recovers from syntax errors rather than throwing, which is what
 * makes it safe to run over a file an agent is halfway through writing.
 */
export function javascriptFacts(file: string, source: string): Inside {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split('\n');

  const symbols: CodeSymbol[] = [];
  const references: Reference[] = [];

  const lineOf = (node: ts.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const endLineOf = (node: ts.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const textAt = (line: number): string => (lines[line - 1] ?? '').trim();

  const refer = (kind: Reference['kind'], name: string, line: number, args?: number) => {
    references.push({
      kind,
      name,
      line,
      text: textAt(line),
      ...(args === undefined ? {} : { args }),
    });
  };

  /** Expressions that are the target of a call, so they are reported once. */
  const called = new Set<ts.Node>();

  /** What a class owns, so `Chart.draw` reads as one thing rather than two. */
  const owner: string[] = [];
  const qualify = (name: string) => [...owner, name].join('.');

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        kind: owner.length > 0 ? 'method' : 'function',
        name: qualify(node.name.text),
        detail: signature(node),
        line: lineOf(node),
        endLine: endLineOf(node),
      });
      refer('definition', node.name.text, lineOf(node));
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      symbols.push({
        kind: 'class',
        name: qualify(name),
        detail: '',
        line: lineOf(node),
        endLine: endLineOf(node),
      });
      refer('definition', name, lineOf(node));

      owner.push(name);
      node.forEachChild(visit);
      owner.pop();
      return;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.push({
        kind: 'method',
        name: qualify(node.name.text),
        detail: signature(node),
        line: lineOf(node),
        endLine: endLineOf(node),
      });
      refer('definition', node.name.text, lineOf(node));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const line = lineOf(node);
      // A `const` holding an arrow function is a function however it was spelled;
      // this repository's JS declares most of its behaviour that way.
      const initialiser = node.initializer;
      const isFunction =
        initialiser !== undefined &&
        (ts.isArrowFunction(initialiser) || ts.isFunctionExpression(initialiser));

      if (owner.length === 0 || isFunction) {
        symbols.push({
          kind: isFunction ? 'function' : 'const',
          name: qualify(name),
          detail: isFunction ? signature(initialiser) : short(initialiser?.getText(tree) ?? ''),
          line,
          endLine: endLineOf(node),
        });
      }
      refer(isFunction ? 'definition' : 'assignment', name, line);
    } else if (ts.isImportDeclaration(node)) {
      for (const name of importedNames(node)) refer('import', name, lineOf(node));
    } else if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name !== null) refer('call', name, lineOf(node), node.arguments.length);
      // The thing being called is reported once, as a call. Without this,
      // `math.solve(x)` came back as both a call and an attribute.
      called.add(node.expression);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      if (!called.has(node)) refer('attribute', node.name.text, lineOf(node));
    } else if (ts.isIdentifier(node) && isPlainRead(node, called)) {
      // A name merely read. Without this a constant used in its own module looked
      // unused, which is the dangerous direction for a tool an agent trusts.
      refer('read', node.text, lineOf(node));
    }

    node.forEachChild(visit);
  };

  tree.forEachChild(visit);
  return { symbols, references };

  function signature(node: ts.SignatureDeclarationBase): string {
    const params = node.parameters.map((p) => p.getText(tree)).join(', ');
    return `(${short(params, 80)})`;
  }
}

/**
 * The name a call names. `solve(…)`, `math.solve(…)` and `this.solve(…)` all report
 * `solve` — the owner is on the source line beside it, and splitting them would hide
 * the calls someone was looking for.
 */
function calledName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name.text;
  }
  return null;
}

/**
 * Whether this identifier is a name being *used*, rather than one being declared or
 * one already reported as something more specific.
 *
 * Identifiers are everywhere in a TypeScript tree — every declaration, every property,
 * every label — so reporting all of them would bury the answer. These are the ones a
 * reader means by "where is this used".
 */
function isPlainRead(node: ts.Identifier, called: ReadonlySet<ts.Node>): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;

  // Already reported as a call.
  if (called.has(node)) return false;
  // `a.b` — `b` is the attribute, reported as one; `a` is a read and falls through.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  // `{ b: 1 }` and `a?.b` and `a["b"]` name members, not variables.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  // The name side of anything being declared: it is a definition, not a use.
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // Imports are reported as imports.
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  return true;
}

function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];

  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
    else for (const element of clause.namedBindings.elements) names.push(element.name.text);
  }
  return names;
}

function short(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
