import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { wbServer, wbTools, type ToolContext } from './server.ts';
import { qualified, WB_TOOL_NAMES } from './names.ts';

async function worktree(files: Record<string, string>): Promise<ToolContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-tools-'));
  for (const [where, content] of Object.entries(files)) {
    const at = path.join(root, where);
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.writeFile(at, content);
  }
  return { worktree: root, scratch: `${root}.scratch`, protectedPaths: ['workbench'] };
}

/** Calls a tool the way the SDK does, and returns what the model would read. */
async function call(ctx: ToolContext, name: string, args: object) {
  const found = wbTools(ctx).find((t) => t.name === name);
  assert.ok(found, `no tool named ${name}`);
  const result = await found.handler(args as never, undefined);
  const blocks = (result.content ?? []) as { text?: string }[];
  const text = blocks.map((b) => b.text ?? '').join('');
  return { text, isError: result.isError === true };
}

const PROJECT = {
  'lib/solve.py': [
    'import numpy as np',
    '',
    'def newton_step(x, tol=1e-9):',
    '    return x - tol',
    '',
    'def run(cases):',
    '    return [newton_step(c) for c in cases]',
    '',
  ].join('\n'),
  'lib/report.py': ['from solve import newton_step', '', 'value = newton_step(0.5, 1e-6)', ''].join(
    '\n',
  ),
  'notes.md': ['# Findings', '', 'newton_step is mentioned here in prose.', ''].join('\n'),
};

test('map says what is in a file without the file being read', async () => {
  const ctx = await worktree(PROJECT);

  const { text, isError } = await call(ctx, 'map', { path: 'lib/solve.py' });

  assert.equal(isError, false);
  assert.match(text, /newton_step\(x, tol=1e-09\)|newton_step\(x, tol=1e-9\)/);
  assert.match(text, /run\(cases\)/);
  assert.match(text, /3-4/, 'with the lines it spans, so a read can be aimed');

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('map narrows to a directory, and says so when there is nothing there', async () => {
  const ctx = await worktree(PROJECT);

  const inside = await call(ctx, 'map', { path: 'lib' });
  assert.match(inside.text, /solve\.py/);
  assert.match(inside.text, /report\.py/);
  assert.doesNotMatch(inside.text, /notes\.md/, 'a directory is not the whole tree');

  const nowhere = await call(ctx, 'map', { path: 'webapp' });
  assert.match(nowhere.text, /Nothing at webapp/);

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('where answers how a name is used, in one call', async () => {
  const ctx = await worktree(PROJECT);

  const { text } = await call(ctx, 'where', { name: 'newton_step' });

  assert.match(text, /definition \(1\)[\s\S]*lib\/solve\.py:3/);
  assert.match(text, /import \(1\)[\s\S]*lib\/report\.py:1/);
  assert.match(text, /call \(2\)/);
  assert.match(text, /lib\/solve\.py:7 \[1 args\]/);
  assert.match(
    text,
    /lib\/report\.py:3 \[2 args\]/,
    'the argument counts differ and both are shown',
  );

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('where does not pretend to have searched the prose', async () => {
  // notes.md mentions newton_step. Reporting that as a reference would be a worse
  // Grep wearing the authority of a parser.
  const ctx = await worktree(PROJECT);

  const { text } = await call(ctx, 'where', { name: 'newton_step', path: 'notes.md' });

  assert.match(text, /No definition, call or other use/);

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('a tool cannot be talked out of the worktree', async () => {
  // The handler runs in the workbench's own process, where a relative path resolves
  // somewhere else entirely, so every one has to be taken back to the worktree.
  const ctx = await worktree(PROJECT);

  for (const escape of ['../..', '/etc', '~/.ssh']) {
    const { text, isError } = await call(ctx, 'map', { path: escape });
    assert.equal(isError, true, escape);
    assert.match(text, /outside this ticket's workspace/, escape);
  }

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('a stage is offered exactly the tools it was granted', async () => {
  // allowedTools auto-approves rather than restricts, so anything registered is in
  // the prompt whether or not the stage can call it — and a tool it cannot call is a
  // turn it will spend finding that out.
  const ctx = await worktree(PROJECT);

  const both = wbServer(ctx, [...WB_TOOL_NAMES, 'Read']);
  assert.deepEqual(Object.keys(both), ['wb']);

  const one = wbServer(ctx, [qualified('where'), 'Read']);
  assert.deepEqual(Object.keys(one), ['wb']);

  const none = wbServer(ctx, ['Read', 'Bash']);
  assert.deepEqual(none, {}, 'a stage granted no workbench tool gets no server at all');

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});

test('a broken file costs an answer, not the workbench', async () => {
  // An unhandled rejection in a handler is wb serve going down and taking every
  // concurrent ticket with it.
  const ctx = await worktree({ 'bad.py': 'def (:\n' });

  const { text, isError } = await call(ctx, 'map', { path: 'bad.py' });

  assert.equal(isError, false);
  assert.match(text, /will not parse/);

  await fs.rm(ctx.worktree, { recursive: true, force: true });
});
