import type { FileFacts, Reference, RefKind } from './symbols.ts';

/**
 * What the index looks like once an agent has to read it.
 *
 * Both of these are paid for in context, so they are written to be scanned rather than
 * to be complete: one line per thing, the line number first, and no repetition of what
 * the line above already said.
 */

/**
 * The shape of the whole worktree, file by file.
 *
 * Deliberately file-level. Every symbol in this repository is about 900 lines of text,
 * which is worth more than it costs only to the stage that is about to change one of
 * them — and that stage can ask. What every stage needs is to stop running `Glob`.
 */
/**
 * Past this many files, naming every one costs more context than knowing them saves,
 * and the map falls back to directories. This repository is around 60 files a worktree,
 * so the fallback is for a tree nobody here has yet — but a map that quietly became
 * 4,000 lines would be a worse orientation problem than the one it set out to fix.
 */
const MAX_FILES_LISTED = 400;

export function fileMap(facts: readonly FileFacts[]): string {
  const byDirectory = new Map<string, FileFacts[]>();
  for (const file of facts) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    byDirectory.set(dir, [...(byDirectory.get(dir) ?? []), file]);
  }
  const directories = [...byDirectory].sort((a, b) => a[0].localeCompare(b[0]));

  const lines: string[] = [];
  if (facts.length > MAX_FILES_LISTED) {
    lines.push(`${facts.length} files, too many to name. By directory:`, '');
    for (const [dir, files] of directories) {
      const total = files.reduce((sum, f) => sum + f.lines, 0);
      lines.push(`  ${dir}/  ${files.length} files, ${total} lines`);
    }
    return lines.join('\n');
  }

  for (const [dir, files] of directories) {
    lines.push(`${dir}/`);
    for (const file of files) {
      lines.push(`  ${name(file)}  ${summarise(file)}`);
    }
  }

  // Said once, at the bottom, for all of them. Reading a `.png` returns zero bytes and
  // costs a whole turn, and it happened 107 times in the recorded corpus.
  if (facts.some((f) => f.kind === 'image')) {
    lines.push('', 'Images and PDFs cannot be read as text — check the numbers that produced one.');
  }
  return lines.join('\n');
}

/** Everything defined in these files, with where it starts and ends. */
export function outline(facts: readonly FileFacts[]): string {
  const lines: string[] = [];

  for (const file of facts) {
    if (file.symbols.length === 0) {
      lines.push(`${file.path}  ${summarise(file)}`);
      continue;
    }
    lines.push(`${file.path}  (${file.lines} lines)`);
    for (const symbol of file.symbols) {
      const span =
        symbol.endLine > symbol.line ? `${symbol.line}-${symbol.endLine}` : `${symbol.line}`;
      lines.push(`  ${span.padEnd(9)} ${symbol.kind.padEnd(8)} ${symbol.name}${symbol.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * Everywhere a name is used, and how.
 *
 * Grouped by what the use *is*, because that is the question and a list of line matches
 * is not an answer to it — which is why a stage that greps then reads the files it was
 * pointed at, and why the same file comes back 2.6 times a run.
 */
export function references(facts: readonly FileFacts[], name: string): string {
  const order: RefKind[] = ['definition', 'assignment', 'import', 'call', 'attribute', 'read'];
  const found = new Map<RefKind, { path: string; ref: Reference }[]>();

  for (const file of facts) {
    for (const ref of file.references) {
      if (ref.name !== name) continue;
      found.set(ref.kind, [...(found.get(ref.kind) ?? []), { path: file.path, ref }]);
    }
  }

  if (found.size === 0) return `No definition, call or other use of \`${name}\`.`;

  const lines: string[] = [];
  for (const kind of order) {
    const hits = found.get(kind);
    if (hits === undefined) continue;

    lines.push(`${kind} (${hits.length})`);
    for (const { path, ref } of hits) {
      const args = ref.args === undefined ? '' : ` [${ref.args} args]`;
      lines.push(`  ${path}:${ref.line}${args}  ${ref.text}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function name(file: FileFacts): string {
  return file.path.includes('/') ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.path;
}

/** One file in one clause: how big it is, and what is in it. */
function summarise(file: FileFacts): string {
  if (file.note !== undefined) return file.note;
  if (file.unparsed !== undefined) return `${file.lines} lines — will not parse: ${file.unparsed}`;

  const counted = new Map<string, number>();
  for (const symbol of file.symbols) counted.set(symbol.kind, (counted.get(symbol.kind) ?? 0) + 1);

  const what = [...counted].map(([kind, n]) => `${n} ${n === 1 ? kind : plural(kind)}`).join(', ');
  return what === '' ? `${file.lines} lines` : `${file.lines} lines — ${what}`;
}

function plural(kind: string): string {
  return kind === 'class' ? 'classes' : `${kind}s`;
}
