import type { ReactNode } from 'react';

/**
 * Markdown, as React elements. Not as HTML: nothing here is ever handed to
 * `dangerouslySetInnerHTML`, so a document cannot put a script on the board
 * however it is written.
 *
 * It covers what the agent and skill files actually use — headings, lists, fenced
 * code, tables, quotes, rules, and the four inline marks. Anything it does not
 * know is left as the text it was, which is the only failure worth having: the
 * document is still readable, and the Edit tab shows it exactly as written.
 */
export function Markdown({ text }: { text: string }) {
  const { front, body } = split(text);
  return (
    <div className="md">
      {front !== null && <pre className="front">{front}</pre>}
      {blocks(body)}
    </div>
  );
}

/**
 * Frontmatter, kept apart. It is not prose and rendering it as prose makes the
 * opening rule a horizontal line and the fields a paragraph — but it is the whole
 * configuration of an agent, so it is shown rather than hidden.
 */
function split(text: string): { front: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match === null
    ? { front: null, body: text }
    : { front: (match[1] as string).trim(), body: text.slice(match[0].length) };
}

function blocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let at = 0;
  const key = () => `b${at}`;

  while (at < lines.length) {
    const line = lines[at] as string;

    if (line.trim() === '') {
      at += 1;
      continue;
    }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const start = at + 1;
      let end = start;
      while (end < lines.length && !/^\s*```/.test(lines[end] as string)) end += 1;
      out.push(<pre key={key()}>{lines.slice(start, end).join('\n')}</pre>);
      at = end + 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2';
      out.push(<Tag key={key()}>{inline(heading[2] as string)}</Tag>);
      at += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      at += 1;
      continue;
    }

    // A table needs its separator row, or `| not a table |` in a sentence becomes one.
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[at + 1] ?? '')) {
      const start = at;
      at += 2;
      while (at < lines.length && (lines[at] as string).trim().startsWith('|')) at += 1;
      out.push(table(key(), lines.slice(start, at)));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = at;
      while (at < lines.length && /^\s*>/.test(lines[at] as string)) at += 1;
      const quoted = lines
        .slice(start, at)
        .map((one) => one.replace(/^\s*>\s?/, ''))
        .join('\n');
      out.push(<blockquote key={key()}>{blocks(quoted)}</blockquote>);
      continue;
    }

    if (bullet(line) !== null) {
      const start = at;
      while (at < lines.length && (bullet(lines[at] as string) !== null || continues(lines, at))) {
        at += 1;
      }
      out.push(list(key(), lines.slice(start, at)));
      continue;
    }

    // A paragraph: everything up to the next blank line or the next block that
    // starts one of its own.
    const start = at;
    while (
      at < lines.length &&
      (lines[at] as string).trim() !== '' &&
      !opensBlock(lines[at] as string)
    ) {
      at += 1;
    }
    out.push(<p key={key()}>{inline(lines.slice(start, at).join('\n'))}</p>);
  }

  return out;
}

/** Whether a line starts a block of its own, and so ends the paragraph before it. */
function opensBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*(---|\*\*\*|___)\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    bullet(line) !== null
  );
}

/** What this line is an item of, if it is one: its indent, its marker and its text. */
function bullet(line: string): { indent: number; ordered: boolean; text: string } | null {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (match === null) return null;
  return {
    indent: (match[1] as string).length,
    ordered: /\d/.test(match[2] as string),
    text: match[3] as string,
  };
}

/** A wrapped item's second line: indented, and not itself an item. */
function continues(lines: string[], at: number): boolean {
  const line = lines[at] as string;
  return line.trim() !== '' && /^\s{2,}\S/.test(line) && bullet(line) === null;
}

/**
 * One list, with anything indented under an item nested inside it. Recursive on
 * indent, so `- a` with `  - b` under it reads as it was written rather than as two
 * items at the same level.
 */
function list(id: string, lines: string[]): ReactNode {
  const first = bullet(lines[0] as string);
  const Tag = first?.ordered === true ? 'ol' : 'ul';
  const items: ReactNode[] = [];
  let at = 0;

  while (at < lines.length) {
    const item = bullet(lines[at] as string);
    if (item === null) {
      at += 1;
      continue;
    }
    const start = at;
    at += 1;
    // Everything under this item: deeper items, and wrapped lines of its own text.
    while (at < lines.length) {
      const next = bullet(lines[at] as string);
      if (next !== null && next.indent <= item.indent) break;
      if (next === null && !continues(lines, at)) break;
      at += 1;
    }

    const rest = lines.slice(start + 1, at);
    const nested = rest.filter((one) => bullet(one) !== null);
    const wrapped = rest.filter((one) => bullet(one) === null).map((one) => one.trim());

    items.push(
      <li key={`${id}i${start}`}>
        {inline([item.text, ...wrapped].join(' '))}
        {nested.length > 0 && list(`${id}n${start}`, dedent(rest))}
      </li>,
    );
  }

  return <Tag key={id}>{items}</Tag>;
}

/** The nested lines, shifted left so the recursion sees them at their own level. */
function dedent(lines: string[]): string[] {
  const indents = lines
    .map((one) => bullet(one)?.indent)
    .filter((n): n is number => n !== undefined);
  const least = Math.min(...indents);
  return lines.filter((one) => bullet(one) !== null).map((one) => one.slice(least));
}

function table(id: string, rows: string[]): ReactNode {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());

  const head = cells(rows[0] as string);
  return (
    <table key={id}>
      <thead>
        <tr>
          {head.map((cell, i) => (
            <th key={i}>{inline(cell)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(2).map((row, r) => (
          <tr key={r}>
            {cells(row).map((cell, c) => (
              <td key={c}>{inline(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `code`, **bold**, *italic* and links. Code is matched first, so a mark inside it
 * stays what it was typed as.
 *
 * Underscores are not italics here. `mcp__wb__map` is a tool name that appears all
 * over these documents, and reading the middle of it as emphasis is a worse answer
 * than not supporting a mark nothing in them uses.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let match: RegExpExecArray | null;
  // Its own, not a shared one: this calls itself for what is inside a mark, and a
  // module-level `g` regex would have the inner call move the outer one's place.
  const marks = new RegExp(INLINE.source, 'g');

  while ((match = marks.exec(text)) !== null) {
    if (match.index > at) out.push(text.slice(at, match.index));
    const found = match[0];
    const key = `i${match.index}`;

    // Bold and italic hold marks of their own — `**`mcp__wb__map`**` is how every
    // one of these documents names a tool — so their contents go round again.
    if (found.startsWith('`')) out.push(<code key={key}>{found.slice(1, -1)}</code>);
    else if (found.startsWith('**'))
      out.push(<strong key={key}>{inline(found.slice(2, -2))}</strong>);
    else if (found.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(found);
      out.push(
        <a key={key} href={link?.[2]} target="_blank" rel="noreferrer">
          {link?.[1]}
        </a>,
      );
    } else out.push(<em key={key}>{inline(found.slice(1, -1))}</em>);

    at = match.index + found.length;
  }

  if (at < text.length) out.push(text.slice(at));
  return out;
}
