import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCheckRunner } from './checks.ts';

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wb-checks-'));
}

test('a passing check reports what it said', async () => {
  const where = await scratchDir();
  try {
    const results = await createCheckRunner(['echo all good'])(where);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[0]?.command, 'echo all good');
    assert.match(results[0]?.output ?? '', /all good/);
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('checks run in the ticket worktree, not wherever the workbench happens to be', async () => {
  const where = await scratchDir();
  try {
    await fs.writeFile(path.join(where, 'only-here.txt'), 'x\n');
    const results = await createCheckRunner(['ls only-here.txt'])(where);

    assert.equal(results[0]?.ok, true, 'the file is only findable from the worktree');
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('a failing check keeps its output, because that becomes the rejection reason', async () => {
  // A bare "exit 1" would waste the trip back to planning: the next plan needs to
  // know what broke, and a summary of a test failure is worse than the failure.
  const where = await scratchDir();
  try {
    const results = await createCheckRunner(['echo "3 tests failed" && exit 1'])(where);

    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.output ?? '', /3 tests failed/);
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('output on stderr counts, which is where most failures say what happened', async () => {
  const where = await scratchDir();
  try {
    const results = await createCheckRunner(['echo "boom" >&2; exit 2'])(where);

    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.output ?? '', /boom/);
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('a command that does not exist is a failed check, not a crash', async () => {
  // To everything above here these are the same thing: the checks did not pass. A
  // throw would park the ticket as blocked, which is wrong — nothing is stuck.
  const where = await scratchDir();
  try {
    const results = await createCheckRunner(['definitely-not-a-real-command'])(where);

    assert.equal(results[0]?.ok, false);
    assert.notEqual(results[0]?.output, '', 'and it says what went wrong');
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('every configured check runs, and each is reported separately', async () => {
  const where = await scratchDir();
  try {
    const results = await createCheckRunner(['true', 'false', 'echo last'])(where);

    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false, true],
      'one failing check does not stop the rest',
    );
    assert.deepEqual(
      results.map((r) => r.command),
      ['true', 'false', 'echo last'],
    );
  } finally {
    await fs.rm(where, { recursive: true, force: true });
  }
});

test('no checks configured means no results and nothing run', async () => {
  assert.deepEqual(await createCheckRunner([])(await scratchDir()), []);
});
