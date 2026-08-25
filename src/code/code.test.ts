import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { indexTree, type FileFacts } from './symbols.ts';
import { fileMap, outline, references } from './report.ts';

/**
 * A worktree with known contents in it. Everything here is asserted against what this
 * function wrote, never against the real repository — a test that reads `lib/solve.py`
 * fails the day someone renames a function, which is the edit you most want them to make.
 */
async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-code-'));
  for (const [where, content] of Object.entries(files)) {
    const at = path.join(root, where);
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.writeFile(at, content);
  }
  return root;
}

const find = (facts: FileFacts[], where: string): FileFacts => {
  const found = facts.find((f) => f.path === where);
  assert.ok(found, `${where} was not indexed`);
  return found;
};

/** The first 24 bytes are all a PNG needs to say how big it is. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test('a Python file gives up its functions, classes and constants', async () => {
  const root = await tree({
    'calc.py': [
      'import numpy as np',
      '',
      'BASE_RATE = 287.05',
      '',
      'def total_cost(units_n, rate_per_unit=293.0) -> float:',
      '    return units_n * BASE_RATE * rate_per_unit',
      '',
      'class Ledger:',
      '    def balance_gbp(self, month_n):',
      '        return stroke_m * 2.0',
      '',
    ].join('\n'),
  });

  const facts = await indexTree(root);
  const calc = find(facts, 'calc.py');

  assert.equal(calc.kind, 'python');
  assert.equal(calc.lines, 10);

  const byName = new Map(calc.symbols.map((s) => [s.name, s]));

  assert.equal(byName.get('BASE_RATE')?.kind, 'const');
  assert.equal(byName.get('BASE_RATE')?.detail, '287.05');

  const cost = byName.get('total_cost');
  assert.equal(cost?.kind, 'function');
  assert.equal(cost?.detail, '(units_n, rate_per_unit=293.0) -> float');
  assert.equal(cost?.line, 5);
  assert.equal(cost?.endLine, 6, 'the range is what makes a symbol readable without the file');

  assert.equal(byName.get('Ledger')?.kind, 'class');
  assert.equal(
    byName.get('Ledger.balance_gbp')?.kind,
    'method',
    'and it is qualified, because an unqualified balance_gbp names nothing',
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('a function nested in a function is not a method', async () => {
  // Calling a closure a method sends a reader looking for a class that is not there.
  const root = await tree({
    'outer.py': [
      'def outer(a):',
      '    def inner(b):',
      '        return b',
      '    return inner',
      '',
    ].join('\n'),
  });

  const facts = await indexTree(root);
  const inner = find(facts, 'outer.py').symbols.find((s) => s.name === 'outer.inner');

  assert.equal(inner?.kind, 'function');

  await fs.rm(root, { recursive: true, force: true });
});

test('Python that will not parse is still a file with a size', async () => {
  // A broken file is a fact about the tree, not a reason to have no index.
  const root = await tree({ 'broken.py': 'def (:\n    oops\n' });

  const facts = await indexTree(root);
  const broken = find(facts, 'broken.py');

  assert.match(broken.unparsed ?? '', /line \d+/);
  assert.equal(broken.lines, 2);
  assert.deepEqual(broken.symbols, []);

  await fs.rm(root, { recursive: true, force: true });
});

test('JavaScript gives up declared functions, arrow constants and classes', async () => {
  const root = await tree({
    'app.js': [
      "import { draw } from './draw.js';",
      '',
      'const SCALE = 2;',
      '',
      'function total(units, rate) {',
      '  return units * rate;',
      '}',
      '',
      'const render = (state) => draw(state, SCALE);',
      '',
      'class Gauge {',
      '  update(value) {',
      '    return value;',
      '  }',
      '}',
      '',
    ].join('\n'),
  });

  const facts = await indexTree(root);
  const app = find(facts, 'app.js');
  const byName = new Map(app.symbols.map((s) => [s.name, s]));

  assert.equal(byName.get('total')?.kind, 'function');
  assert.equal(byName.get('total')?.detail, '(units, rate)');
  assert.equal(byName.get('SCALE')?.kind, 'const');
  assert.equal(
    byName.get('render')?.kind,
    'function',
    'a const holding an arrow function is a function however it was spelled',
  );
  assert.equal(byName.get('Gauge')?.kind, 'class');
  assert.equal(byName.get('Gauge.update')?.kind, 'method');

  await fs.rm(root, { recursive: true, force: true });
});

test('a Markdown file gives up its headings, tables and figures', async () => {
  const root = await tree({
    'report.md': [
      '# Results',
      '',
      'Some prose.',
      '',
      '| z | p |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '![the sweep](sweep.png)',
      '',
      '## Discussion',
      '',
      '```bash',
      '# not a heading, it is a shell comment',
      '```',
      '',
    ].join('\n'),
  });

  const facts = await indexTree(root);
  const report = find(facts, 'report.md');
  const kinds = report.symbols.map((s) => `${s.kind}:${s.name}`);

  assert.ok(kinds.includes('heading:Results'));
  assert.ok(kinds.includes('heading:Discussion'));
  assert.ok(kinds.includes('figure:sweep.png'));

  const table = report.symbols.find((s) => s.kind === 'table');
  assert.equal(table?.line, 5, 'a table is cited by the line it starts on');
  assert.equal(table?.detail, 'z | p');

  assert.equal(
    report.symbols.filter((s) => s.kind === 'heading').length,
    2,
    'a # inside a fence is a shell comment, not a heading',
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('an image says how big it is instead of coming back empty', async () => {
  // 107 Read calls in the recorded corpus were aimed at .png files and every one
  // returned nothing, at full context.
  const root = await tree({ 'plot.png': png(1536, 813) });

  const facts = await indexTree(root);
  const plot = find(facts, 'plot.png');

  assert.equal(plot.kind, 'image');
  assert.equal(plot.note, 'PNG 1536×813');

  await fs.rm(root, { recursive: true, force: true });
});

test('the map says why an image cannot be read once, not once per image', async () => {
  const root = await tree({
    'a.png': png(10, 10),
    'b.png': png(20, 20),
    'c.png': png(30, 30),
  });

  const map = fileMap(await indexTree(root));
  const said = map.split('cannot be read').length - 1;

  assert.equal(said, 1, 'saying it per file was a third of the map');

  await fs.rm(root, { recursive: true, force: true });
});

test('copies of the tree are not part of the tree', async () => {
  // A worktree indexing its siblings reports every count five to ten times too big,
  // and in a worktree `.git` is a file rather than a directory.
  const root = await tree({
    'keep.py': 'x = 1\n',
    '.git': 'gitdir: /somewhere/else\n',
    'node_modules/pkg/index.js': 'export const no = 1;\n',
    '__pycache__/keep.cpython-311.pyc': 'binary-ish\n',
    '.worktrees/t1/keep.py': 'x = 2\n',
    'dist/bundle.js': 'var no = 1;\n',
  });

  const indexed = (await indexTree(root)).map((f) => f.path);

  assert.deepEqual(indexed, ['keep.py']);

  await fs.rm(root, { recursive: true, force: true });
});

test('a file edited after it was indexed is read again', async () => {
  // The cache is keyed on mtime and size. An agent editing a file it just read is the
  // common case, and a stale symbol table would be worse than none.
  const root = await tree({ 'mod.py': 'def before():\n    pass\n' });

  const first = find(await indexTree(root), 'mod.py');
  assert.deepEqual(
    first.symbols.map((s) => s.name),
    ['before'],
  );

  await fs.writeFile(path.join(root, 'mod.py'), 'def after():\n    pass\n');
  const second = find(await indexTree(root), 'mod.py');

  assert.deepEqual(
    second.symbols.map((s) => s.name),
    ['after'],
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('a file created after the first index is found', async () => {
  // Per-file mtime says nothing about a file that did not exist, so the tree is walked
  // fresh every time. An agent creating a file with Bash is ordinary work.
  const root = await tree({ 'one.py': 'a = 1\n' });
  await indexTree(root);

  await fs.writeFile(path.join(root, 'two.py'), 'b = 2\n');
  const paths = (await indexTree(root)).map((f) => f.path);

  assert.deepEqual(paths, ['one.py', 'two.py']);

  await fs.rm(root, { recursive: true, force: true });
});

test('binary data is not counted as lines of text', async () => {
  const root = await tree({ 'store.db': Buffer.from([0x53, 0x51, 0x00, 0x0a, 0x0a, 0x0a]) });

  const store = find(await indexTree(root), 'store.db');

  assert.equal(store.lines, 0);
  assert.match(store.note ?? '', /^binary,/);

  await fs.rm(root, { recursive: true, force: true });
});

test('references say how a name is used, not merely where', async () => {
  // This is the whole difference from Grep: a line match sends the agent back to read
  // the file to find out what the match meant, which is where the re-reads come from.
  const root = await tree({
    'model.py': ['def solve(a, b):', '    return a + b', ''].join('\n'),
    'run.py': [
      'from model import solve',
      '',
      'answer = solve(1, 2)',
      'again = solve(1, 2, 3)',
      '',
    ].join('\n'),
  });

  const said = references(await indexTree(root), 'solve');

  assert.match(said, /definition \(1\)/);
  assert.match(said, /model\.py:1/);
  assert.match(said, /import \(1\)/);
  assert.match(said, /call \(2\)/);
  assert.match(said, /run\.py:3 \[2 args\]/, 'the argument count is the interpretation');
  assert.match(said, /run\.py:4 \[3 args\]/);

  await fs.rm(root, { recursive: true, force: true });
});

test('a name nobody uses says so, rather than saying nothing', async () => {
  const root = await tree({ 'model.py': 'x = 1\n' });

  assert.match(references(await indexTree(root), 'nowhere'), /No definition, call or other use/);

  await fs.rm(root, { recursive: true, force: true });
});

test('an outline places every symbol without opening the file', async () => {
  const root = await tree({
    'calc.py': ['def one():', '    pass', '', 'def two():', '    pass', ''].join('\n'),
  });

  const said = outline(await indexTree(root));

  assert.match(said, /calc\.py {2}\(5 lines\)/);
  assert.match(said, /1-2 +function +one\(\)/);
  assert.match(said, /4-5 +function +two\(\)/);

  await fs.rm(root, { recursive: true, force: true });
});

test('a name merely read is a use, in Python and in JavaScript', async () => {
  // A constant used inside its own module reported the assignment and nothing else,
  // so `where` said it was unused where it was not. That is the dangerous direction
  // to be wrong in: an agent trusts the answer and deletes something.
  const root = await tree({
    'mod.py': ['TOTAL = 3', '', 'def go(x):', '    return x + TOTAL', ''].join('\n'),
    'mod.js': ['const TOTAL = 3;', '', 'function go(x) {', '  return x + TOTAL;', '}', ''].join(
      '\n',
    ),
  });

  const facts = await indexTree(root);

  for (const where of ['mod.py', 'mod.js']) {
    const read = find(facts, where).references.filter(
      (r) => r.name === 'TOTAL' && r.kind === 'read',
    );
    assert.equal(read.length, 1, `${where} should report the read`);
    assert.equal(read[0]?.line, 4, where);
  }

  await fs.rm(root, { recursive: true, force: true });
});

test('the thing being called is reported once, not twice', async () => {
  // m.convert(x) came back as both a call and an attribute, so every method call in
  // the codebase counted double and "call (6)" meant three.
  const root = await tree({
    'mod.py': ['import other as m', '', 'def go(x):', '    return m.convert(x)', ''].join('\n'),
    'mod.js': ['function go(x) {', '  return m.convert(x);', '}', ''].join('\n'),
  });

  const facts = await indexTree(root);

  for (const where of ['mod.py', 'mod.js']) {
    const convert = find(facts, where).references.filter((r) => r.name === 'convert');
    assert.deepEqual(
      convert.map((r) => r.kind),
      ['call'],
      where,
    );
  }

  await fs.rm(root, { recursive: true, force: true });
});
