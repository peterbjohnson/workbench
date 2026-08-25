import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CodeSymbol, Reference } from './symbols.ts';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'py_symbols.py');

/** Long enough for a tree of this size, short enough that a wedged parse is not a wedged ticket. */
const TIMEOUT_MS = 30_000;

export type Inside = {
  symbols: CodeSymbol[];
  references: Reference[];
  unparsed?: string;
};

/**
 * What is in each of these Python files, from Python's own parser.
 *
 * Regexes over Python are wrong in the places that matter — a decorator, a nested
 * `def`, a name inside a docstring — and being wrong here is worse than having nothing,
 * because an agent trusts a tool that says it knows.
 *
 * Nothing throws. A missing interpreter, a timeout or a crashed helper all come back as
 * an empty map, and the caller falls through to a file with no symbols in it: the map
 * is thinner than it should be, which is a degradation, not a broken index.
 */
export async function pythonFacts(absolutePaths: readonly string[]): Promise<Map<string, Inside>> {
  const facts = new Map<string, Inside>();
  if (absolutePaths.length === 0) return facts;

  const output = await runHelper(absolutePaths.join('\n') + '\n');

  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const got = JSON.parse(line) as { path: string } & Inside;
      const { path: where, ...inside } = got;
      facts.set(where, inside);
    } catch {
      // A line that is not JSON is a helper that printed something unexpected. The
      // files it covered simply have no symbols; every other line still stands.
    }
  }
  return facts;
}

function runHelper(input: string): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }

    let out = '';
    const done = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done('');
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => done(''));
    child.on('close', () => done(out));

    // A helper that dies early leaves this writing to a closed pipe, which throws
    // asynchronously and would take the workbench down with it.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
