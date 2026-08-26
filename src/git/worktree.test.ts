import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { commitAll, create, diff, refresh, remove, type GitConfig } from './worktree.ts';

const run = promisify(execFile);

/**
 * A real throwaway repository, laid out as ours is: the project beside the
 * workbench's own source, one commit on main.
 */
async function scratchRepo(protectedPaths?: string[]): Promise<GitConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-git-'));
  const repoRoot = path.join(root, 'repo');
  await fs.mkdir(path.join(repoRoot, 'workbench', 'src'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'project'), { recursive: true });

  const git = (...args: string[]) => run('git', args, { cwd: repoRoot });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoRoot, 'workbench', 'src', 'rules.ts'), 'the guardrails\n');
  await fs.writeFile(path.join(repoRoot, 'project', 'model.py'), 'the work\n');
  await fs.writeFile(path.join(repoRoot, 'package.json'), '{ "name": "the-project" }\n');
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'the project\n');
  await git('add', '-A');
  await git('commit', '-m', 'first');

  return { repoRoot, worktreeRoot: path.join(root, 'worktrees'), base: 'main', protectedPaths };
}

const cleanUp = (cfg: GitConfig) =>
  fs.rm(path.dirname(cfg.repoRoot), { recursive: true, force: true });

async function present(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('a ticket gets its own branch and directory', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');

    assert.equal(wt.branch, 'wb/t1');
    assert.ok(wt.path.endsWith(path.join('worktrees', 't1')));
    assert.ok(await present(path.join(wt.path, 'project', 'model.py')), 'the base is checked out');
  } finally {
    await cleanUp(cfg);
  }
});

test('two tickets do not collide', async () => {
  const cfg = await scratchRepo();
  try {
    const one = await create(cfg, 't1');
    const two = await create(cfg, 't2');

    await fs.writeFile(path.join(one.path, 'a.txt'), 'from t1\n');
    await fs.writeFile(path.join(two.path, 'b.txt'), 'from t2\n');
    await commitAll(one, 'work on t1');
    await commitAll(two, 'work on t2');

    assert.match(await diff(cfg, one), /a\.txt[\s\S]*from t1/);
    assert.doesNotMatch(await diff(cfg, one), /b\.txt/);
    assert.match(await diff(cfg, two), /b\.txt[\s\S]*from t2/);
  } finally {
    await cleanUp(cfg);
  }
});

test('create is idempotent, so a restart mid-ticket resumes', async () => {
  const cfg = await scratchRepo();
  try {
    const first = await create(cfg, 't1');
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n');

    const second = await create(cfg, 't1');

    assert.equal(second.path, first.path);
    assert.equal(second.branch, first.branch);
    assert.equal(second.base, null, 'only the call that cut the branch reports a base');
    assert.equal(await fs.readFile(path.join(second.path, 'work.txt'), 'utf8'), 'in progress\n');
  } finally {
    await cleanUp(cfg);
  }
});

test('committing reports whether there was anything to commit', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await commitAll(wt, 'nothing yet'), null, 'nothing to commit');

    await fs.writeFile(path.join(wt.path, 'a.txt'), 'hello\n');
    assert.match((await commitAll(wt, 'add a')) ?? '', /^[0-9a-f]{40}$/, 'the sha is the record');
    assert.match(await diff(cfg, wt), /\+hello/);
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket gets a scratch directory beside its worktree, not inside it', async () => {
  // t4 wrote a probe into the worktree because it had nowhere else, and it survived
  // only because verify remembered to delete it. Scratch is outside the worktree, so
  // nothing left in it can reach a commit however forgetful the agent was.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await present(wt.scratch), true, 'it exists before any stage runs');
    assert.equal(path.dirname(wt.scratch), path.dirname(wt.path), 'beside the worktree');
    assert.equal(await present(path.join(wt.path, path.basename(wt.scratch))), false, 'not in it');

    await fs.writeFile(path.join(wt.scratch, 'probe.py'), 'assert False\n');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    await commitAll(wt, 'improve the model');

    const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: wt.path });
    assert.doesNotMatch(stdout, /probe\.py/, 'the probe cannot reach the commit');

    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: wt.path });
    assert.equal(dirty.trim(), '', 'and it does not even show as untracked');
  } finally {
    await cleanUp(cfg);
  }
});

test('the scratch directory survives a restart mid-ticket, and goes when the worktree does', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.scratch, 'notes.txt'), 'working it out\n');

    await create(cfg, 't1'); // the worktree already exists; scratch must still be there
    assert.equal(await present(path.join(wt.scratch, 'notes.txt')), true);

    await remove(cfg, 't1');
    assert.equal(await present(wt.scratch), false, 'tidied up with the worktree');
  } finally {
    await cleanUp(cfg);
  }
});

test('removing a worktree leaves the branch, which may be in a pull request', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'hello\n');
    await commitAll(wt, 'add a');

    await remove(cfg, 't1');
    await assert.rejects(() => fs.stat(wt.path), 'the directory is gone');

    const { stdout } = await run('git', ['branch', '--list', 'wb/t1'], { cwd: cfg.repoRoot });
    assert.match(stdout, /wb\/t1/, 'the branch survives');

    await remove(cfg, 't1'); // removing again is not an error
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket branches from the remote, not from a stale local base', async () => {
  // The bug this exists for: a pull request merged on the code host leaves local
  // main behind, and a ticket branched from it works against code that no longer
  // exists. The first live one asked why the files it was told to delete were not
  // there — and it was right.
  const cfg = await scratchRepo();
  try {
    const remote = path.join(path.dirname(cfg.repoRoot), 'remote.git');
    await run('git', ['init', '--bare', '-b', 'main', remote]);
    await run('git', ['remote', 'add', 'origin', remote], { cwd: cfg.repoRoot });
    await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: cfg.repoRoot });

    // Someone merges something. It reaches the remote; this checkout knows nothing.
    const elsewhere = path.join(path.dirname(cfg.repoRoot), 'elsewhere');
    await run('git', ['clone', '-q', remote, elsewhere]);
    await run('git', ['config', 'user.email', 'other@example.com'], { cwd: elsewhere });
    await run('git', ['config', 'user.name', 'Other'], { cwd: elsewhere });
    await fs.writeFile(path.join(elsewhere, 'merged.txt'), 'from the remote\n');
    await run('git', ['add', '-A'], { cwd: elsewhere });
    await run('git', ['commit', '-q', '-m', 'merged elsewhere'], { cwd: elsewhere });
    await run('git', ['push', '-q'], { cwd: elsewhere });

    const wt = await create(cfg, 't1');

    assert.equal(
      await fs.readFile(path.join(wt.path, 'merged.txt'), 'utf8'),
      'from the remote\n',
      'the ticket sees the merge, without anyone pulling',
    );
    const local = await run('git', ['log', '-1', '--format=%s', 'main'], { cwd: cfg.repoRoot });
    assert.equal(local.stdout.trim(), 'first', "and the manager's own main was left alone");
  } finally {
    await cleanUp(cfg);
  }
});

// The workbench and the project live in one repository, so a ticket's worktree
// would normally contain the guardrails the agent runs under. These are the three
// things that have to hold at once: absent from disk, present in the commit, and
// invisible to the diff.

test('without protection, an agent worktree contains the workbench', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    assert.equal(await present(path.join(wt.path, 'workbench', 'src', 'rules.ts')), true);
  } finally {
    await cleanUp(cfg);
  }
});

test('a protected path may be a file, not only a directory', async () => {
  // The repository root's `package.json` names the workbench version it installs, so
  // it decides which workbench governs the next ticket. A trailing slash in the
  // sparse-checkout pattern made every entry directory-only and left the file on disk.
  const cfg = await scratchRepo(['workbench', 'package.json']);
  try {
    const wt = await create(cfg, 't1');

    assert.equal(await present(path.join(wt.path, 'package.json')), false, 'the file is gone');
    assert.equal(
      await present(path.join(wt.path, 'README.md')),
      true,
      'and the root is not emptied along with it',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('protected directories are simply not in the worktree', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');

    assert.equal(
      await present(path.join(wt.path, 'workbench')),
      false,
      'the workbench is not on disk, so no tool can reach it',
    );
    assert.equal(
      await present(path.join(wt.path, 'project', 'model.py')),
      true,
      'the work itself is still there',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('committing from a protected worktree does not delete the workbench', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    assert.match((await commitAll(wt, 'improve the model')) ?? '', /^[0-9a-f]{40}$/);

    // The critical check: the commit must still carry the files that were hidden.
    const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: wt.path,
    });
    const files = stdout.split('\n').filter((l) => l !== '');
    assert.ok(
      files.includes('workbench/src/rules.ts'),
      `the workbench must survive the commit, got: ${files.join(', ')}`,
    );
    assert.ok(files.includes('project/model.py'));

    const kept = await run('git', ['show', 'HEAD:workbench/src/rules.ts'], { cwd: wt.path });
    assert.equal(kept.stdout, 'the guardrails\n', 'and its contents must be unchanged');
  } finally {
    await cleanUp(cfg);
  }
});

test('the protected directory survives a diff against the base branch', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'changed\n');
    await commitAll(wt, 'change the model');

    const { stdout } = await run('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: wt.path,
    });
    assert.deepEqual(
      stdout.split('\n').filter((l) => l !== ''),
      ['project/model.py'],
      'only the work shows as changed',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a ticket can carry on from another, with its work already in the worktree', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 does some work and stops without ever being accepted. Its commit is on
    // its branch and nowhere else — which, before this, meant nowhere reachable.
    const first = await create(cfg, 't1');
    await fs.writeFile(path.join(first.path, 'project', 'draft.md'), '# a draft\n');
    const stranded = await commitAll(first, 'implement: a draft (t1)');
    assert.ok(stranded);

    const second = await create(cfg, 't2', 'wb/t1');

    const draft = await fs.readFile(path.join(second.path, 'project', 'draft.md'), 'utf8');
    assert.equal(draft, '# a draft\n', "t1's work is on disk in t2's own worktree");
    assert.equal(second.base, stranded, 't2 is cut from where t1 stopped');

    // And the new ticket's diff is its own work, not the work it inherited.
    await fs.writeFile(path.join(second.path, 'project', 'draft.md'), '# a better draft\n');
    await commitAll(second, 'implement: fix the draft (t2)');

    const own = await diff(cfg, second, second.base);
    assert.match(own, /a better draft/);
    assert.doesNotMatch(own, /new file/, 'the inherited draft is not presented as new work');

    // Against main it would be the whole thing — which is what a reviewer would
    // otherwise have been handed.
    assert.match(await diff(cfg, second), /new file/);
  } finally {
    await cleanUp(cfg);
  }
});

// A ticket's diff is read by a model on a budget, and the size of a change and
// the size of its diff are unrelated: t-mimi's was one function and two tests,
// plus a generated 15,862-row CSV it had committed. Review spent its whole $3 on
// the first request, before it had read anything.

/** Lines that look like generated output: dense, numeric and endless. */
function rows(tag: string, n: number): string {
  const body = Array.from({ length: n }, (_, i) => `${i},${i * 1.5},${i * 2.5},${i * 3.5}`);
  return [`# ${tag}`, ...body, ''].join('\n');
}

/** What git itself would have handed over, for comparison. */
async function rawDiff(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['diff', 'main...HEAD'], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

test('a generated file is reduced to its stat line, and the real change is untouched', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.mkdir(path.join(wt.path, 'agent_made'));
    await fs.writeFile(path.join(wt.path, 'agent_made', 'geometry.csv'), rows('geometry', 15862));
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, done properly\n');
    await commitAll(wt, 'implement: the work, and the data it produced');

    const shown = await diff(cfg, wt);

    assert.match(shown, /^\+the work, done properly$/m, 'the change itself is all still there');
    assert.doesNotMatch(shown, /^\+9000,/m, 'the generated rows are not');
    assert.match(shown, /agent_made\/geometry\.csv/, 'but the file is still named');
    assert.match(shown, /15863/, 'and how much of it was left out is said');

    const raw = await rawDiff(wt.path);
    assert.ok(
      shown.length < raw.length / 10,
      `the size is the cost: ${shown.length} of ${raw.length} characters`,
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('many files with nothing large in any one of them are cut down too', async () => {
  // The other way to be too big, and it needed solving as well: a mechanical
  // change across a few hundred files, no single one of them over the per-file
  // cap. The largest go first, so the most files stay readable in full.
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const many = 80;
    for (let i = 0; i < many; i++) {
      await fs.writeFile(path.join(wt.path, 'project', `part${i}.csv`), rows(`part${i}`, i * 10));
    }
    await commitAll(wt, 'implement: a great many files');

    const shown = await diff(cfg, wt);
    const raw = await rawDiff(wt.path);

    assert.ok(shown.length < raw.length / 2, `${shown.length} of ${raw.length} characters`);
    for (let i = 0; i < many; i++) {
      assert.match(shown, new RegExp(`project/part${i}\\.csv`), `part${i} is still named`);
    }
    assert.match(shown, /^\+# part0$/m, 'and the smallest are still there to be read');
    assert.doesNotMatch(shown, /^\+# part79$/m, 'while the largest gave up its body');
  } finally {
    await cleanUp(cfg);
  }
});

test('an ordinary change is passed through exactly as git wrote it', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the work, improved\n');
    await fs.writeFile(path.join(wt.path, 'project', 'new.py'), 'and something new\n');
    await commitAll(wt, 'implement: the work');

    assert.equal(await diff(cfg, wt), await rawDiff(wt.path), 'nothing to save, nothing done');
  } finally {
    await cleanUp(cfg);
  }
});

/** A commit landing on the base while a ticket is busy — another ticket merging. */
async function landOnBase(cfg: GitConfig, file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(cfg.repoRoot, file), content);
  await run('git', ['add', '-A'], { cwd: cfg.repoRoot });
  await run('git', ['commit', '-m', `landed ${file}`], { cwd: cfg.repoRoot });
}

test('a branch that already has the base is left completely alone', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    assert.deepEqual(await refresh(cfg, 't1'), { kind: 'up-to-date' });

    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.equal(after.stdout, before.stdout, 'no commit, so nothing to re-check');
  } finally {
    await cleanUp(cfg);
  }
});

test('a base that moved on is merged in, and is then on disk to work against', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await landOnBase(cfg, 'project/other.py', 'work that landed first\n');

    const result = await refresh(cfg, 't1');

    assert.equal(result.kind, 'merged');
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'other.py'), 'utf8'),
      'work that landed first\n',
      'the ticket is now working against what is actually there',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('a conflict is reported, and the branch is left exactly as it was', async () => {
  const cfg = await scratchRepo();
  try {
    const wt = await create(cfg, 't1');
    await fs.writeFile(path.join(wt.path, 'project', 'model.py'), 'the ticket said this\n');
    await commitAll(wt, 'the ticket');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    await landOnBase(cfg, 'project/model.py', 'the base says this\n');

    const result = await refresh(cfg, 't1');

    assert.equal(result.kind, 'conflicted');
    assert.deepEqual(result.kind === 'conflicted' ? result.paths : [], ['project/model.py']);
    assert.equal(
      result.kind === 'conflicted' ? result.with : '',
      result.kind === 'conflicted' ? result.base : 'x',
      'and what it would not merge was the base',
    );

    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.equal(after.stdout, before.stdout, 'no half-merged branch to clean up');
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'model.py'), 'utf8'),
      'the ticket said this\n',
      'and no conflict markers left in the work',
    );
  } finally {
    await cleanUp(cfg);
  }
});

/** A ticket that has offered its work: a branch with a commit on it, nothing merged. */
async function offeredWork(cfg: GitConfig, ticketId: string, file: string, content: string) {
  const wt = await create(cfg, ticketId);
  await fs.mkdir(path.dirname(path.join(wt.path, file)), { recursive: true });
  await fs.writeFile(path.join(wt.path, file), content);
  await commitAll(wt, `${ticketId} did the work`);
  return wt;
}

test('the work a ticket waited for is merged in, and is then on disk to build on', async () => {
  const cfg = await scratchRepo();
  try {
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    await offeredWork(cfg, 't2', 'project/second.py', 'what t2 wrote\n');
    const wt = await create(cfg, 't3');

    const result = await refresh(cfg, 't3', ['wb/t1', 'wb/t2']);

    assert.equal(result.kind, 'merged');
    assert.deepEqual(
      result.kind === 'merged' ? result.merged : [],
      ['wb/t1', 'wb/t2'],
      'and it says what it took, so the caller can record it',
    );
    // Both of them: two dependencies offered at once is the ordinary case, and a
    // ticket that got only the first would be built on half of what it waited for.
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'first.py'), 'utf8'),
      'what t1 wrote\n',
    );
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'second.py'), 'utf8'),
      'what t2 wrote\n',
    );
  } finally {
    await cleanUp(cfg);
  }
});

test('work that already landed in the base is not merged a second time', async () => {
  const cfg = await scratchRepo();
  try {
    // t1 offered, and then its pull request was merged — so its branch is in the
    // base, and a ticket cut afterwards already has everything it waited for.
    await offeredWork(cfg, 't1', 'project/first.py', 'what t1 wrote\n');
    await run('git', ['merge', '--no-edit', 'wb/t1'], { cwd: cfg.repoRoot });
    await create(cfg, 't2');

    assert.deepEqual(await refresh(cfg, 't2', ['wb/t1']), { kind: 'up-to-date' });
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency that will not merge is named, and what merged before it stands', async () => {
  const cfg = await scratchRepo();
  try {
    await offeredWork(cfg, 't1', 'project/shared.py', 'what t1 wrote\n');
    await offeredWork(cfg, 't2', 'project/shared.py', 'what t2 wrote, differently\n');
    const wt = await create(cfg, 't3');
    const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });

    const result = await refresh(cfg, 't3', ['wb/t1', 'wb/t2']);

    assert.equal(result.kind, 'conflicted');
    assert.equal(result.kind === 'conflicted' ? result.with : '', 'wb/t2');
    assert.deepEqual(result.kind === 'conflicted' ? result.paths : [], ['project/shared.py']);

    // t1 merged cleanly first and is left where it is: the ticket is as far along
    // as it got, and throwing that away would be work redone for nothing.
    assert.equal(
      await fs.readFile(path.join(wt.path, 'project', 'shared.py'), 'utf8'),
      'what t1 wrote\n',
      'no conflict markers, and t1 still merged',
    );
    const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
    assert.notEqual(after.stdout, before.stdout, 'the first merge is a commit on the branch');
    await assert.rejects(
      run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wt.path }),
      'and no merge is left in progress',
    );

    // Which is said in the result as well as left on disk: a caller told only that
    // it conflicted would record the branch as being where it no longer is.
    assert.deepEqual(result.kind === 'conflicted' ? result.merged : [], ['wb/t1']);
    assert.equal(
      result.kind === 'conflicted' ? result.commit : '',
      after.stdout.trim(),
      'and the commit it reports is the one the branch is standing on',
    );
    await run('git', ['merge-base', '--is-ancestor', 'wb/t1', after.stdout.trim()], {
      cwd: wt.path,
    });
  } finally {
    await cleanUp(cfg);
  }
});

test('a dependency with no branch of its own is nothing to merge', async () => {
  const cfg = await scratchRepo();
  try {
    await create(cfg, 't2');

    // Released by being cancelled before it ever cut a branch. Asking git to merge
    // a ref that is not there would read as a conflict, which it is not.
    assert.deepEqual(await refresh(cfg, 't2', ['wb/t1']), { kind: 'up-to-date' });
  } finally {
    await cleanUp(cfg);
  }
});

test('a merge cannot put the workbench into a protected worktree', async () => {
  const cfg = await scratchRepo(['workbench']);
  try {
    const wt = await create(cfg, 't1');
    // The merge has to write this file out, which is exactly what would materialise
    // a path the sparse checkout is keeping off disk.
    await landOnBase(cfg, 'workbench/src/rules.ts', 'the guardrails, revised\n');

    assert.equal((await refresh(cfg, 't1')).kind, 'merged');

    assert.equal(
      await present(path.join(wt.path, 'workbench')),
      false,
      'still beyond every tool an agent has',
    );
  } finally {
    await cleanUp(cfg);
  }
});
