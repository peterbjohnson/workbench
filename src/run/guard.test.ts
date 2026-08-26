import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guard, type GuardContext } from './guard.ts';
import { WB_TOOL_NAMES } from '../tools/names.ts';

const PLAN: GuardContext = {
  worktree: '/tmp/wb/t1',
  allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
};

const IMPLEMENT: GuardContext = {
  worktree: '/tmp/wb/t1',
  scratch: '/tmp/wb/t1.scratch',
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'],
};

function reason(r: ReturnType<typeof guard>): string {
  return r.allow ? '' : r.reason;
}

test('a tool the stage was not granted is refused', () => {
  const r = guard(PLAN, 'Write', { file_path: '/tmp/wb/t1/notes.md' });
  assert.equal(r.allow, false);
  assert.match(reason(r), /not granted/);
});

test('granted tools inside the worktree are allowed', () => {
  assert.deepEqual(guard(PLAN, 'Read', { file_path: '/tmp/wb/t1/src/a.ts' }), { allow: true });
  assert.deepEqual(guard(PLAN, 'Read', { file_path: 'src/a.ts' }), { allow: true });
  assert.deepEqual(guard(PLAN, 'Glob', { pattern: '**/*.ts' }), { allow: true });
  assert.deepEqual(guard(IMPLEMENT, 'Write', { file_path: '/tmp/wb/t1/new.ts' }), {
    allow: true,
  });
});

test('paths outside the workspace are refused however they are written', () => {
  const outside = [
    '/etc/passwd',
    '/tmp/wb/t2/other.ts',
    '../t2/other.ts',
    '/tmp/wb/t1/../t2/other.ts',
    '~/.ssh/id_rsa',
    '/tmp/wb/t1-sibling/x.ts', // prefix match must not be enough
    '/tmp/wb/t1.scratch-other/x.ts', // nor for the scratch directory
  ];
  for (const file_path of outside) {
    const r = guard(IMPLEMENT, 'Write', { file_path });
    assert.equal(r.allow, false, `${file_path} should be refused`);
    assert.match(reason(r), /outside this ticket's workspace/);
  }
});

test('the worktree root itself is inside it', () => {
  assert.deepEqual(guard(PLAN, 'Grep', { pattern: 'x', path: '/tmp/wb/t1' }), { allow: true });
});

test('the scratch directory is writable, and is reached from the worktree', () => {
  // Verify tried /tmp for a probe, was refused, and wrote it into the worktree
  // instead — where it would have shipped. This is the place that was missing.
  for (const file_path of [
    '/tmp/wb/t1.scratch/probe.py',
    '/tmp/wb/t1.scratch/deep/probe.py',
    '../t1.scratch/probe.py', // relative paths resolve from the worktree, the agent's cwd
  ]) {
    assert.deepEqual(guard(IMPLEMENT, 'Write', { file_path }), { allow: true }, file_path);
  }
});

test('a stage with no scratch directory is held to the worktree alone', () => {
  const r = guard(PLAN, 'Read', { file_path: '/tmp/wb/t1.scratch/probe.py' });
  assert.equal(r.allow, false);
  assert.match(reason(r), /work only inside \/tmp\/wb\/t1/, 'and is not told about one');
});

test('the agent may not commit, push, or manage worktrees', () => {
  for (const command of [
    'git commit -m "wip"',
    'git push origin HEAD',
    'git worktree add ../other',
  ]) {
    const r = guard(IMPLEMENT, 'Bash', { command });
    assert.equal(r.allow, false, `${command} should be refused`);
  }
  assert.match(reason(guard(IMPLEMENT, 'Bash', { command: 'git push' })), /workbench pushes/);
});

test('sudo is refused', () => {
  assert.equal(guard(IMPLEMENT, 'Bash', { command: 'sudo apt install thing' }).allow, false);
});

test('a recursive delete inside the workspace is ordinary work', () => {
  // The blanket ban on -r refused an agent clearing its own scratch directory and
  // cost a turn every time. What matters is where it points, not which flag it has.
  for (const command of [
    'rm -rf build',
    'rm -fr build',
    'rm -R build',
    'rm -f -r build',
    'yarn build && rm -rf dist',
    'rm -rf /tmp/wb/t1.scratch/clone',
    'rm -rf ../t1.scratch/clone',
    "rm -rf 'build'",
    'rm -rf -- build',
  ]) {
    assert.deepEqual(guard(IMPLEMENT, 'Bash', { command }), { allow: true }, command);
  }
});

test('a recursive delete pointing out of the workspace is refused', () => {
  for (const command of [
    'rm -rf /etc',
    'rm -rf ~/Documents',
    'rm -rf ../t2',
    'cd /tmp && rm -rf /tmp/wb/t2',
  ]) {
    const r = guard(IMPLEMENT, 'Bash', { command });
    assert.equal(r.allow, false, command);
    assert.match(reason(r), /outside this ticket's workspace/);
  }
});

test('a recursive delete that cannot be read is refused rather than guessed at', () => {
  for (const command of ['rm -rf $BUILD', 'rm -rf `pwd`/dist', 'rm -rf *', 'rm -rf build/*']) {
    const r = guard(IMPLEMENT, 'Bash', { command });
    assert.equal(r.allow, false, command);
    assert.match(reason(r), /could expand to anything/);
  }

  const bare = guard(IMPLEMENT, 'Bash', { command: 'rm -rf' });
  assert.equal(bare.allow, false, 'and one naming nothing at all is refused too');
});

test('the workspace directories themselves may not be removed', () => {
  for (const command of ['rm -rf /tmp/wb/t1', 'rm -rf .', 'rm -rf /tmp/wb/t1.scratch']) {
    const r = guard(IMPLEMENT, 'Bash', { command });
    assert.equal(r.allow, false, command);
    assert.match(reason(r), /the workbench owns/);
  }
});

test('ordinary shell commands are allowed', () => {
  for (const command of ['yarn test', 'git status', 'git diff', 'rm stale.txt', 'ls -la']) {
    assert.deepEqual(guard(IMPLEMENT, 'Bash', { command }), { allow: true }, command);
  }
});

test('malformed tool input is treated as pathless rather than crashing', () => {
  assert.deepEqual(guard(PLAN, 'Read', {}), { allow: true });
  assert.deepEqual(guard(PLAN, 'Read', null), { allow: true });
  assert.deepEqual(guard(PLAN, 'Read', { file_path: 42 }), { allow: true });
});

const PROTECTED: GuardContext = {
  worktree: '/tmp/wb/t1',
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  protectedPaths: ['workbench'],
};

test('agents may read the workbench but never write to it', () => {
  assert.deepEqual(
    guard(PROTECTED, 'Read', { file_path: '/tmp/wb/t1/workbench/src/rules.ts' }),
    { allow: true },
    'reading its own guardrails is harmless',
  );

  for (const tool of ['Write', 'Edit', 'NotebookEdit'] as const) {
    const r = guard(
      { ...PROTECTED, allowedTools: [...PROTECTED.allowedTools, 'NotebookEdit'] },
      tool,
      { file_path: '/tmp/wb/t1/workbench/src/rules.ts', notebook_path: '/tmp/wb/t1/workbench/x' },
    );
    assert.equal(r.allow, false, `${tool} into the workbench must be refused`);
    assert.match(reason(r), /read-only to agents/);
  }
});

test('protection covers the whole directory, however the path is written', () => {
  for (const file_path of [
    'workbench/src/rules.ts',
    '/tmp/wb/t1/workbench/agents/plan.md',
    './workbench/package.json',
    'project/../workbench/src/x.ts',
  ]) {
    assert.equal(guard(PROTECTED, 'Write', { file_path }).allow, false, file_path);
  }
});

test('work outside the protected directory is untouched', () => {
  assert.deepEqual(guard(PROTECTED, 'Write', { file_path: 'project/model.py' }), {
    allow: true,
  });
  assert.deepEqual(guard(PROTECTED, 'Write', { file_path: 'workbenches/x.py' }), {
    allow: true,
  });
});

test('the agent may not undo its own isolation through git', () => {
  for (const command of [
    'git sparse-checkout disable',
    'git config core.sparseCheckout false',
    'git checkout main -- workbench/',
    'git switch main',
    'git reset --hard',
    'git rebase main',
    // The workbench hands a stage a conflicted merge to finish. Aborting it would
    // pass the end guard by throwing away the very thing the stage was asked to do.
    'git merge --abort',
  ]) {
    assert.equal(guard(PROTECTED, 'Bash', { command }).allow, false, command);
  }
});

test('Skill reads the workbench’s own expertise, and nothing else on the machine', () => {
  // No agent lists Skill in allowedTools: a bare entry there auto-approves the tool
  // before anything can inspect which skill was asked for. This list is the grant.
  const held = { ...IMPLEMENT, skills: ['workbench:writing-python'] };

  assert.equal(guard(held, 'Skill', { skill: 'workbench:writing-python' }).allow, true);
  // Qualified or bare names the same expertise; no turn is lost to the prefix.
  assert.equal(guard(held, 'Skill', { skill: 'writing-python' }).allow, true);

  // A skill the session advertises but the workbench does not hold — `doctor` was
  // in every live run's init line, off the machine the workbench happened to be on.
  assert.equal(guard(held, 'Skill', { skill: 'doctor' }).allow, false);
  assert.equal(guard(IMPLEMENT, 'Skill', { skill: 'writing-python' }).allow, false);
  assert.equal(guard({ ...IMPLEMENT, skills: [] }, 'Skill', {}).allow, false);

  // A refusal says what there is. t16 stopped a whole stage for want of this.
  assert.match(reason(guard(held, 'Skill', { skill: 'technical-report' })), /writing-python/);

  // It is Skill specifically, not a hole for anything a stage was not granted.
  assert.equal(guard(held, 'WebFetch', { url: 'https://example.com' }).allow, false);
});

test('a path is confined wherever in the arguments it appears', () => {
  // The confinement used to be a table of tool name to field name, so a tool the
  // table had never heard of contributed no paths and the check ran zero times.
  // The workbench's own tools take batches, and confining the first item of a batch
  // while ignoring the rest would be worse than not checking at all.
  const asking = { ...PLAN, allowedTools: ['mcp__wb__where'] };

  assert.equal(guard(asking, 'mcp__wb__where', { paths: ['lib/solve.py'] }).allow, true);

  const escaped = guard(asking, 'mcp__wb__where', {
    paths: ['lib/solve.py', '../../../etc/passwd'],
  });
  assert.equal(escaped.allow, false, 'the second item of a batch is checked too');
  assert.match(reason(escaped), /outside this ticket's workspace/);

  const nested = guard(asking, 'mcp__wb__where', {
    reads: [{ path: 'lib/solve.py' }, { path: '/etc/shadow' }],
  });
  assert.equal(nested.allow, false, 'and a path nested inside an array of objects');
});

test('a tool nobody granted is refused whatever it names', () => {
  assert.equal(guard(PLAN, 'mcp__wb__where', { paths: ['lib/solve.py'] }).allow, false);
});

test('the workbench tools an agent may be granted all exist', () => {
  // A name in frontmatter that no tool answers to is a tool advertised and then
  // refused, which costs a turn every time it is believed.
  for (const name of WB_TOOL_NAMES) {
    assert.match(name, /^mcp__wb__[a-z_]+$/, name);
  }
  assert.ok(WB_TOOL_NAMES.length > 0);
});
