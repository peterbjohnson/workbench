import fs from 'node:fs/promises';
import path from 'node:path';

import { pythonFacts } from './python.ts';
import { javascriptFacts } from './js.ts';
import { markdownFacts } from './markdown.ts';

/**
 * What is in a file, without reading the file.
 *
 * Agents spend most of their turns finding out things about this repository that are
 * true every ticket: which files exist, what is defined in them, and where a name is
 * used. All of that is decidable from the source, so none of it should cost a model
 * call — and a `Grep` result is not an answer to "how is this used", which is why the
 * agent that runs one then re-reads the file it pointed at.
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'const'
  // A report's shape is what its tickets are about, so a document has symbols too.
  | 'heading'
  | 'table'
  | 'figure';

export type CodeSymbol = {
  kind: SymbolKind;
  /** Qualified where that means something: `Grid.spacing_m`, not `spacing_m`. */
  name: string;
  /** The signature, the base list, the value, or the heading depth. */
  detail: string;
  line: number;
  endLine: number;
};

export type RefKind = 'definition' | 'import' | 'call' | 'attribute' | 'assignment' | 'read';

export type Reference = {
  kind: RefKind;
  name: string;
  line: number;
  /** The source line, trimmed. One line is the interpretation; the file is not. */
  text: string;
  /** How many arguments a call was given. A lower bound when the call splats. */
  args?: number;
};

export type FileKind = 'python' | 'javascript' | 'markdown' | 'image' | 'other';

export type FileFacts = {
  /** Relative to the root it was indexed from, and always with forward slashes. */
  path: string;
  kind: FileKind;
  lines: number;
  bytes: number;
  symbols: CodeSymbol[];
  references: Reference[];
  /** What an image is, so nobody spends a turn reading one and getting nothing back. */
  note?: string;
  /** Set when the file could not be parsed. Everything else about it is still true. */
  unparsed?: string;
};

/**
 * Directories that are copies of the tree rather than part of it. Left in, a worktree
 * indexes 26 checked-out siblings and every count comes out five to ten times too big.
 */
const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  '.claude',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.venv',
  'venv',
  '.pytest_cache',
]);

/**
 * In a worktree `.git` is a *file* pointing at the real git directory, so skipping
 * directories by name is not enough to keep git's own plumbing out of the map.
 */
const SKIP_NAMES = new Set(['.git', '.DS_Store']);

/** Past this, a file is data. Parsing a 5MB generated `.js` helps nobody. */
const MAX_BYTES = 512 * 1024;

const KINDS: Record<string, FileKind> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.md': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.pdf': 'image',
};

export function kindOf(file: string): FileKind {
  return KINDS[path.extname(file).toLowerCase()] ?? 'other';
}

/**
 * Parsed files, keyed by where they are and what they were when parsed.
 *
 * Keyed by *absolute* path: tickets run concurrently in slots, and `lib/solve.py` in
 * t1's worktree is a different file from the same relative path in t2's. Size joins
 * mtime because a same-millisecond rewrite of the same length is the one edit mtime
 * alone would miss, and an agent editing a file it just read is the common case here.
 */
const parsed = new Map<string, FileFacts>();

/**
 * How many parsed files to keep. The key includes the mtime, so every edit adds an
 * entry rather than replacing one — and `wb serve` runs for days across dozens of
 * tickets, so without a bound this is a slow leak of every version of every file
 * anyone has touched. Oldest out first; a re-parse costs milliseconds.
 */
const MAX_CACHED = 2_000;

function remember(key: string, facts: FileFacts): void {
  parsed.set(key, facts);
  while (parsed.size > MAX_CACHED) {
    const oldest = parsed.keys().next();
    if (oldest.done === true) break;
    parsed.delete(oldest.value);
  }
}

/**
 * Every file under `root`, with what is in it.
 *
 * The tree is walked fresh every time and never cached: per-file mtime says nothing
 * about a file that has just been created, and an agent creating files with `Bash` is
 * ordinary work. Only the parsing is reused.
 */
export async function indexTree(root: string): Promise<FileFacts[]> {
  const files = await walk(root, root);
  const wanted = files.filter((f) => f.kind !== 'image' && f.bytes <= MAX_BYTES);

  // One `python3` for the whole batch. Startup is most of the cost of parsing this
  // repository's Python, so paying it per file would make the index cost more than
  // the turns it saves.
  const pythonPaths = wanted
    .filter((f) => f.kind === 'python' && !parsed.has(cacheKey(root, f)))
    .map((f) => path.join(root, f.path));
  const fromPython = await pythonFacts(pythonPaths);

  return Promise.all(
    files.map(async (found) => {
      const key = cacheKey(root, found);
      const already = parsed.get(key);
      if (already) return already;

      const facts = await factsFor(root, found, fromPython);
      if (found.bytes <= MAX_BYTES) remember(key, facts);
      return facts;
    }),
  );
}

type Found = { path: string; kind: FileKind; bytes: number; mtimeMs: number };

function cacheKey(root: string, found: Found): string {
  return `${path.join(root, found.path)}:${found.mtimeMs}:${found.bytes}`;
}

async function factsFor(
  root: string,
  found: Found,
  fromPython: Map<string, Omit<FileFacts, 'path' | 'kind' | 'lines' | 'bytes'>>,
): Promise<FileFacts> {
  const absolute = path.join(root, found.path);
  const base = { path: found.path, kind: found.kind, bytes: found.bytes };

  if (found.kind === 'image') {
    return { ...base, lines: 0, symbols: [], references: [], note: await describeImage(absolute) };
  }
  if (found.bytes > MAX_BYTES) {
    return { ...base, lines: 0, symbols: [], references: [], note: 'too large to index' };
  }

  if (found.kind === 'python') {
    const got = fromPython.get(absolute);
    const source = await read(absolute);
    return {
      ...base,
      lines: countLines(source),
      symbols: got?.symbols ?? [],
      references: got?.references ?? [],
      ...(got?.unparsed !== undefined ? { unparsed: got.unparsed } : {}),
    };
  }

  const source = await read(absolute);

  // A `.db` or a `.dat` counted by its newlines reads as "1079 lines" of something a
  // reader might open. Saying it is binary is both true and shorter.
  if (source.includes('\u0000')) {
    return { ...base, lines: 0, symbols: [], references: [], note: `binary, ${size(found.bytes)}` };
  }

  const inside =
    found.kind === 'javascript'
      ? javascriptFacts(found.path, source)
      : found.kind === 'markdown'
        ? markdownFacts(source)
        : { symbols: [], references: [] };

  return { ...base, lines: countLines(source), ...inside };
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}kB`;
  return `${bytes}B`;
}

async function read(absolute: string): Promise<string> {
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return '';
  }
}

function countLines(source: string): number {
  if (source === '') return 0;
  const breaks = source.split('\n').length;
  return source.endsWith('\n') ? breaks - 1 : breaks;
}

/**
 * What an image is, in the fewest words that are still an answer. 107 `Read` calls in
 * the recorded corpus were aimed at `.png` files and every one came back with nothing —
 * a full-context round trip for zero bytes, several times per plotting ticket.
 *
 * Terse on purpose: *why* an image cannot be read is the same sentence for every one of
 * them, so the map says it once rather than fourteen times, which was a third of it.
 */
async function describeImage(absolute: string): Promise<string> {
  const kind = path.extname(absolute).slice(1).toUpperCase();
  const shape = await png(absolute);
  return shape === null ? kind : `${kind} ${shape.width}×${shape.height}`;
}

/** A PNG says its size in the IHDR chunk, which is always the first 24 bytes. */
async function png(absolute: string): Promise<{ width: number; height: number } | null> {
  if (path.extname(absolute).toLowerCase() !== '.png') return null;
  try {
    const handle = await fs.open(absolute);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(24), 0, 24, 0);
      if (bytesRead < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function walk(root: string, dir: string): Promise<Found[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: Found[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await walk(root, absolute)));
      continue;
    }
    // Symlinks are not followed: a link out of the worktree would index a tree the
    // agent is not allowed to touch, and one back into it would index it twice.
    if (!entry.isFile() || SKIP_NAMES.has(entry.name)) continue;

    try {
      const stat = await fs.stat(absolute);
      found.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        kind: kindOf(entry.name),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Gone between readdir and stat. Nothing to say about it.
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
