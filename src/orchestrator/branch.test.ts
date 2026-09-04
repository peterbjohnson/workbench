import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Verdict } from './loop.ts';
import { create, during, harness, ok, standing, waiting } from './harness.ts';
import type { Refreshed, Stage } from '../domain/events.ts';

test('a ticket let go by a pull request is branched onto that work, not without it', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'merged',
      base: 'abc1234',
      commit: 'merge01',
      merged: ['wb/t1', 'wb/t3'],
    }),
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't3');
    waiting(h.store, 't2', ['t1', 't3']);

    await h.orch.idle();

    // Both, in the order they were waited for. An offer is not a merge, so neither
    // of them is in the base — the commit t2 needs is made on t2's own branch.
    assert.deepEqual(
      h.refreshed.filter((r) => r.id === 't2')[0]?.alsoMerge,
      ['wb/t1', 'wb/t3'],
      'the work it waited for came with it',
    );

    // Before anything was paid for: a ticket that starts on the wrong code runs
    // implement and verify to completion and only then finds out.
    const events = h.store.eventsFor('t2').map((e) => e.type);
    assert.ok(events.indexOf('branched') < events.indexOf('refreshed'), 'cut, then merged onto');
    assert.ok(events.indexOf('refreshed') < events.indexOf('stage_started'), 'before the stage');

    // And measured from the merge: every stage is handed `diff(base...HEAD)`, so a
    // base left at abc1234 would show t1's and t3's work as t2's own.
    assert.equal(h.store.ticket('t2').base, 'merge01', 'what t2 writes is measured from here');
  } finally {
    await h.close();
  }
});

test('a branch standing on work it waited for keeps its base as the base moves on', async () => {
  // Two merges: the one that takes t1's work as t2's branch is cut, and one at the
  // pull request, by when the base had moved on again.
  const merges: string[] = [];
  const h = harness({
    refresh: (id, keepConflict) => {
      // The stage-start refreshes are not what this is about: by then the branch has
      // the base, which is what they go for.
      if (keepConflict) return { kind: 'up-to-date' };
      merges.push(id);
      return merges.length === 1
        ? { kind: 'merged', base: 'abc1234', commit: 'merge01', merged: ['wb/t1'] }
        : // Only the base this time: t1's work is already in the branch, so the
          // merge that brings the new base in takes nothing else.
          { kind: 'merged', base: 'newbase', commit: 'merge02', merged: ['newbase'] };
    },
  });
  try {
    standing(h.store, 't1');
    waiting(h.store, 't2', ['t1']);

    await h.orch.idle();
    h.store.append('t2', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.refreshed.filter((r) => !r.keepConflict).map((r) => r.id),
      ['t2', 't2'],
      'refreshed as it was cut, and again to be offered',
    );

    // t1 is still offered, so its work is in t2's branch and in no commit the base
    // has. Measuring from newbase would hand review, verify and then the reviewer
    // the whole of t1's change as t2's own — the failure the merge exists to stop,
    // arriving one refresh later.
    const t2 = h.store.ticket('t2');
    assert.equal(t2.base, 'merge01', 'the base stands where the merge that took t1 put it');
    assert.equal(t2.commits.at(-1), 'merge02', 'the new base is in the branch all the same');
  } finally {
    await h.close();
  }
});

/**
 * A ticket cut onto t1's offered work, offered in its turn, and then refreshed
 * again — one fixture per refresh of t2, in the order they happen. `answers` is how
 * a test says the manager has got round to a pull request.
 */
function carryingT1(merges: Refreshed[]) {
  const answers = new Map<string, Verdict>();
  /** The refreshes of t2 that brought work in, in the order they happened. */
  const brought: Refreshed[] = [];
  const h = harness({
    verdict: (id) => answers.get(id) ?? { kind: 'pending' },
    // The refreshes at the start of a stage are not what these tests are about: by
    // then the branch has the base, which is what they go for. They are the ones
    // that happen while the ticket is running — `keepConflict` no longer tells them
    // apart on its own, now that the pass over the offered branches keeps a clash
    // for an implement run to settle.
    refresh: (id) => {
      if (id !== 't2' || h.store.ticket('t2').running) return { kind: 'up-to-date' };
      const merge = merges.shift() ?? { kind: 'up-to-date' };
      brought.push(merge);
      return merge;
    },
  });
  return { h, answers, brought };
}

/** The merge that took t1, made as t2's branch was cut, and the offer that follows. */
const TOOK_T1: Refreshed[] = [
  { kind: 'merged', base: 'abc1234', commit: 'merge01', merged: ['wb/t1'] },
  { kind: 'merged', base: 'newbase', commit: 'merge02', merged: ['newbase'] },
];

test('a branch keeps its base when what it took stops being offered', async () => {
  const { h, answers, brought } = carryingT1([
    ...TOOK_T1,
    // The base moving on again, under a pull request that is standing.
    { kind: 'merged', base: 'newer001', commit: 'merge03', merged: ['newer001'] },
  ]);
  try {
    waiting(h.store, 't2', ['t1']);
    standing(h.store, 't1');
    standing(h.store, 't3');
    await h.orch.idle();

    h.store.append('t2', { type: 'plan_approved' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'awaiting_verdict');

    // The manager sends t1 back: it is committing again, so there is nothing of it
    // left to take — and its merge is in t2's branch all the same. Then something
    // else merges, which is what brings every standing pull request up to the base.
    h.store.append('t1', { type: 'changes_requested', changes: 'the units' });
    answers.set('t3', { kind: 'accepted' });
    await h.orch.idle();

    const t2 = h.store.ticket('t2');
    assert.equal(brought.length, 3, 'the merge did reach t2');
    assert.equal(t2.base, 'merge01', 'the base stands where the merge that took t1 put it');
    assert.deepEqual(t2.carrying, ['wb/t1'], 'because the branch is still standing on it');
  } finally {
    await h.close();
  }
});

test('a dependency that merged stops holding the base, because the base has it', async () => {
  const { h, answers, brought } = carryingT1([
    ...TOOK_T1,
    // The base t1's pull request landed on, brought in once it had.
    { kind: 'merged', base: 'newer001', commit: 'merge03', merged: ['newer001'] },
  ]);
  try {
    waiting(h.store, 't2', ['t1']);
    standing(h.store, 't1');
    await h.orch.idle();

    h.store.append('t2', { type: 'plan_approved' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').base, 'merge01', 'held while t1 was only offered');

    answers.set('t1', { kind: 'accepted' });
    await h.orch.idle();

    // t1's work is in the base now, so t2's branch is standing on nothing the base
    // has not got: measuring from the base shows t2's own work and all of it, which
    // is what the base is for.
    const t2 = h.store.ticket('t2');
    assert.equal(h.store.ticket('t1').status, 'done');
    assert.equal(brought.length, 3, 'the merge did reach t2');
    assert.deepEqual(t2.carrying, [], 'nothing left that the base has not got');
    assert.equal(t2.base, 'newer001', 'so the base moves on with it');
  } finally {
    await h.close();
  }
});

test('dependencies that will not sit in one tree stop the ticket before it starts', async () => {
  const h = harness({
    // t1 merged, and then t3 would not: what merged before the conflict is on the
    // branch, and the HEAD it left is the one the ticket is standing on.
    refresh: () => ({
      kind: 'conflicted',
      base: 'abc1234',
      paths: ['fea/run_characteristic.py'],
      with: 'wb/t3',
      merged: ['wb/t1'],
      commit: 'merge01',
      merging: false,
    }),
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't3');
    waiting(h.store, 't2', ['t1', 't3']);

    await h.orch.idle();

    const ticket = h.store.ticket('t2');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /wb\/t3/, 'says which one it could not take');
    assert.match(ticket.question?.question ?? '', /run_characteristic\.py/, 'and where it clashed');
    assert.deepEqual(h.ran, [], 'the cheapest moment there is to find this out');
    assert.deepEqual(
      h.store.eventsFor('t2').filter((e) => e.type === 'stage_started'),
      [],
    );

    // And the record says where the branch actually is. Left at abc1234 it would
    // read as being without t1's merge, so the stage that runs once the manager has
    // sorted the conflict out is handed `diff(abc1234...HEAD)` — the whole of t1's
    // change, as t2's own work.
    assert.equal(ticket.base, 'merge01', 'measured from the commit t1 landed on');
    assert.deepEqual(ticket.carrying, ['wb/t1'], 'and it says what it is standing on');
  } finally {
    await h.close();
  }
});

test('a dependency that ended has no work to take, so nothing is merged', async () => {
  const h = harness();
  try {
    // Offered first, and stopped after: the case that matters, because cancelling
    // does not take the offer back. A dependency that never offered anything would
    // be let through by the rule that is wrong as readily as by the one that is right.
    standing(h.store, 't1');
    waiting(h.store, 't2', ['t1']);
    h.store.append('t1', { type: 'cancelled', reason: 'not now' });

    await h.orch.idle();

    // Cancelling lets go of what waits, which is the point of it — but there is no
    // branch of t1's that t2 should be standing on: merging it would ship work the
    // manager stopped, through t2's pull request.
    assert.equal(h.store.ticket('t1').offered, true, 'the offer outlived the cancelling');
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
    assert.deepEqual(h.refreshed, [], 'nothing to take, so nothing was asked of git');
  } finally {
    await h.close();
  }
});

test('a branch that is already on the base records nothing on the way through', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const noise = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'refreshed' || e.type === 'conflicted');
    assert.deepEqual(noise, [], 'refreshing a clean branch costs a merge that does nothing');
  } finally {
    await h.close();
  }
});

test('the base is taken in when a stage starts, not only when the work is offered', async () => {
  // t64 and t65 ran implement and verify to completion — the suite twice over — and
  // heard about the commit that clashed with them on the way to a pull request.
  const h = harness({
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    for (const stage of ['implement', 'verify'] as const) {
      assert.ok(
        during(h.store, 't1', stage).some((e) => e.type === 'refreshed'),
        `${stage} works against the base that exists`,
      );
    }
    for (const stage of ['plan', 'review'] as const) {
      assert.deepEqual(
        during(h.store, 't1', stage).filter((e) => e.type === 'refreshed'),
        [],
        `${stage} can do nothing about a merge, so it is not given one`,
      );
    }
  } finally {
    await h.close();
  }
});

test('a stage that took the base in is given the ticket the merge left, not the one before it', async () => {
  // The brief's diff is taken as `diff(config, worktree, ticket.base)`, from the
  // object the run was handed. A stage still holding the base its branch was cut from
  // reads the whole of the merged-in work as its own — the very failure the refresh
  // is for, one stage along.
  const bases = new Map<Stage, string | null>();
  const h = harness({
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
    runStage: async ({ ticket, stage }) => {
      bases.set(stage, ticket.base);
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(bases.get('implement'), 'newbase');
    assert.equal(bases.get('verify'), 'newbase');
  } finally {
    await h.close();
  }
});
