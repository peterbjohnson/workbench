import type { CodeSymbol, Reference } from './symbols.ts';

export type Inside = { symbols: CodeSymbol[]; references: Reference[] };

/**
 * What is in a Markdown file: its headings, its tables and its figures.
 *
 * A third of the recorded tickets are about reports, and the objections they draw are
 * positional — a table nobody numbered, a paragraph filed under the wrong heading, a
 * figure referred to as "the one above". Answering those means knowing the shape of the
 * document, which is a whole-file read today and one line of an outline here.
 *
 * References come back empty by design. A name in prose is text, not a reference, and
 * `where` says so rather than degrading into a worse `Grep`.
 */
export function markdownFacts(source: string): Inside {
  const lines = source.split('\n');
  const symbols: CodeSymbol[] = [];

  let inFence = false;
  /** The heading a table or figure belongs under, so an outline reads in order. */
  let openHeading: CodeSymbol | undefined;
  let tableAt: number | undefined;

  const closeTable = (endLine: number) => {
    if (tableAt === undefined) return;
    symbols.push({
      kind: 'table',
      name: `table@${tableAt}`,
      detail: headerOf(lines[tableAt - 1] ?? ''),
      line: tableAt,
      endLine,
    });
    tableAt = undefined;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (/^\s*```/.test(line)) {
      closeTable(lineNumber - 1);
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      closeTable(lineNumber - 1);
      if (openHeading) openHeading.endLine = lineNumber - 1;

      openHeading = {
        kind: 'heading',
        name: heading[2] ?? '',
        detail: 'h'.concat(String((heading[1] ?? '').length)),
        line: lineNumber,
        endLine: lines.length,
      };
      symbols.push(openHeading);
      return;
    }

    // A table is a run of pipe rows. Only its first line is recorded, because that is
    // the one a reviewer cites and the one a caption would have to go above.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableAt ??= lineNumber;
    } else {
      closeTable(lineNumber - 1);
    }

    for (const figure of line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      symbols.push({
        kind: 'figure',
        name: figure[2] ?? '',
        detail: figure[1] ?? '',
        line: lineNumber,
        endLine: lineNumber,
      });
    }
  });

  closeTable(lines.length);
  return { symbols, references: [] as Reference[] };
}

/** The column names of a table, which is what identifies it to a reader. */
function headerOf(row: string): string {
  const cells = row
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const joined = cells.join(' | ');
  return joined.length <= 70 ? joined : `${joined.slice(0, 69)}…`;
}
