import { test } from 'node:test';
import assert from 'node:assert/strict';

import { create, harness, standing } from './harness.ts';
import { openStore } from '../store/store.ts';
import { deriveTicket } from '../domain/ticket.ts';
import type { Refreshed } from '../domain/events.ts';

test('a pull request that will not open parks the ticket with the reason', async () => {
  const h = harness({
    openPr: async () => {
      throw new Error('no remote configured');
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked');
    assert.match(t.question?.question ?? '', /no remote configured/);
  } finally {
    await h.close();
  }
});

test('a code host that cannot be reached does not stop the ticket', async () => {
  // Five of the eight tickets ever blocked over GitHub were blocked by this, and
  // one outage took two of them a tenth of a second apart. Reading a verdict is a
  // read, the timer does it again in thirty seconds, and a person was being spent
  // on the network every time.
  let reachable = false;
  const h = harness({
    verdict: () => {
      if (!reachable) throw new Error('error connecting to api.github.com');
      return { kind: 'accepted' };
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'still waiting, not blocked');
    assert.equal(h.store.ticket('t1').question, null, 'and not asking anybody anything');

    reachable = true;
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done', 'it picks the answer up by itself');
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify'], 'nothing was re-run');
  } finally {
    await h.close();
  }
});

test('an outage is said once, and so is coming back from one', async () => {
  let reachable = false;
  const h = harness({
    verdict: () => {
      if (!reachable) throw new Error('error connecting to api.github.com');
      return { kind: 'pending' };
    },
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();
    await h.orch.idle();

    assert.equal(h.announced.length, 1, 'not once per ticket per poll');
    assert.match(h.announced[0] ?? '', /cannot read verdicts[\s\S]*api\.github\.com/);

    reachable = true;
    await h.orch.idle();

    assert.equal(h.announced.length, 2);
    assert.match(h.announced[1] ?? '', /answering again/);
  } finally {
    await h.close();
  }
});

test('merging finishes the ticket and tidies its worktree away', async () => {
  const h = harness({ verdict: { kind: 'accepted' } });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done');
    assert.deepEqual(h.tidied, ['t1'], 'the branch stays, the directory goes');
  } finally {
    await h.close();
  }
});

test('a merge brings every standing pull request up to the base it moved to', async () => {
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done', 'the merge that moved the base');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'awaiting_verdict', 'the other offer still stands');
    assert.equal(t2.base, 'newbase', 'against what is actually there now');
    assert.deepEqual(t2.commits, ['merge01'], 'having taken it in');
  } finally {
    await h.close();
  }
});

test('a cancelled ticket is not brought back up to the base by somebody else merging', async () => {
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    // t1 lands cleanly; the branch nobody is going to resolve is t2's.
    refresh: (id) =>
      id === 't1'
        ? { kind: 'up-to-date' }
        : {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['webapp/bellows.js'],
            with: 'newbase',
            merged: [],
            commit: 'merge01',
            merging: false,
          },
  });
  try {
    standing(h.store, 't2');
    h.store.append('t2', { type: 'cancelled', reason: 'redundant and a mess' });
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // Cancelling does not clear `offered`, so without the check t2 was refreshed
    // like any standing pull request, conflicted against a base it will never be
    // resolved against, and came back onto the board as a question.
    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'cancelled', 'stopped is stopped');
    assert.deepEqual(
      h.refreshed.map((r) => r.id),
      ['t1', 't1', 't1'],
      'the cancelled branch was never touched',
    );
    assert.deepEqual(
      h.store.eventsFor('t2').filter((e) => e.type === 'blocked'),
      [],
      'and nothing was asked of the manager about it',
    );
  } finally {
    await h.close();
  }
});

test('a pull request the manager has already answered is left alone', async () => {
  const h = harness({
    verdict: (id) =>
      id === 't1' ? { kind: 'accepted' } : { kind: 'rejected', reason: 'not like that' },
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // A merge pushed to it would be a commit made for reasons nothing to do with
    // the objection, and a change request the branch has moved past reads as one
    // that has been addressed.
    const refreshed = h.store.eventsFor('t2').filter((e) => e.type === 'refreshed');
    assert.deepEqual(refreshed, [], 'the answer is what it hears, not a merge');
    assert.equal(h.store.ticket('t2').rejection, 'not like that');
  } finally {
    await h.close();
  }
});

/**
 * A merge landing under an offered branch that will not take it. The clash is
 * reported twice — once to the pass over the offered branches, and once to the
 * refresh at the start of the run it hands the merge to, which finds the same
 * merge still on disk — and after that the branch is up to date.
 */
const CLASH: Extract<Refreshed, { kind: 'conflicted' }> = {
  kind: 'conflicted',
  base: 'newbase',
  paths: ['src/domain/rules.ts'],
  with: 'newbase',
  merged: [],
  commit: 'head0001',
  merging: true,
};

function clashingOffer(opts: Parameters<typeof harness>[0] = {}) {
  let asked = 0;
  return harness({
    ...opts,
    refresh: (id) => {
      if (id !== 't2') return { kind: 'up-to-date' };
      return ++asked <= 2 ? CLASH : { kind: 'up-to-date' };
    },
  });
}

test('a clash on an offered branch is settled by a run, not by a click', async () => {
  const handed: unknown[] = [];
  const h = clashingOffer({
    runStage: async ({ conflict }) => {
      handed.push(conflict);
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'the merge that landed bought one implement run');
    assert.deepEqual(
      handed,
      [{ base: 'newbase', paths: ['src/domain/rules.ts'] }],
      'given the merge to finish, the way the start of a stage already is',
    );

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'awaiting_verdict', 'still offered, and nobody was asked anything');
    assert.equal(t2.prUrl, 'https://example/pr/t2', 'on the pull request it already had');
    assert.deepEqual(h.prsOpened, ['https://example/pr/t2'], 'which the resolution was pushed to');
    assert.deepEqual(h.committed, ['t2: implement: ticket t2 (t2)'], 'as a commit of its own');
    assert.equal(t2.base, 'newbase', 'measured from the base it has now taken in');
    assert.deepEqual(h.abandoned, [], 'nothing to undo');
    assert.deepEqual(t2.conflicts, [], 'and nothing left for the manager to resolve');
  } finally {
    await h.close();
  }
});

test('a resolution that leaves a path conflicted is undone, and the manager asked', async () => {
  const h = clashingOffer({ unresolved: (paths) => [...paths] });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.committed, [], 'nothing half-resolved was committed');
    assert.deepEqual(h.abandoned, ['t2'], 'the branch is back where it was');
    assert.deepEqual(h.prsOpened, [], 'and the pull request never saw it');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['src/domain/rules.ts'], 'the panel can still list them');
    const asked = t2.question?.question ?? '';
    assert.match(asked, /src\/domain\/rules\.ts/, 'named as the clash it is');
    assert.match(asked, /resolution was tried/, 'and said to have been attempted');
    assert.match(asked, /still conflicted/, 'with what the attempt left');
  } finally {
    await h.close();
  }
});

test('a resolution the standing checks fail is undone too', async () => {
  // The last moment anything asks: what this leaves is pushed to a pull request a
  // person is reading, and no stage follows it to find out that the suite is broken.
  const h = clashingOffer({
    checks: () => [{ command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' }],
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.committed, [], 'checked before the commit, so there is nothing to undo');
    assert.deepEqual(h.abandoned, ['t2']);
    assert.deepEqual(h.prsOpened, []);

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['src/domain/rules.ts']);
    assert.match(t2.question?.question ?? '', /1 failing/, 'with the failure, not a summary');
    assert.match(t2.question?.question ?? '', /resolution was tried/);
  } finally {
    await h.close();
  }
});

test('a resolution is not pushed onto an offer taken back while it ran', async () => {
  // The window used to be a git merge and is now a whole agent run, and in that
  // time the manager can read the pull request and ask for something else. Pushing
  // the resolution then puts a commit on the offer they have just objected to, and
  // the `pr_opened` that follows it puts the ticket back in front of them as
  // though they had said nothing.
  const store = openStore(':memory:');
  let runs = 0;
  const h = clashingOffer({
    store,
    runStage: async () => {
      // The objection lands during the settle, and every run after it is parked —
      // so what the ticket did about it is `h.ran`, and nothing cascades past it.
      if (++runs > 1) return { outcome: 'blocked', summary: 'not what this is about' };
      store.append('t2', { type: 'changes_requested', changes: 'not like that' });
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, [], 'nothing was pushed to the offer they had objected to');
    assert.deepEqual(
      h.committed,
      ['t2: implement: ticket t2 (t2)'],
      'the resolution is on the branch, where whatever runs next will find it',
    );
    assert.equal(h.store.ticket('t2').offered, false, 'and the offer is still over');

    // And the settle reported back into the objection rather than over it. Routed
    // on the offer, which the objection had just ended, this walked on to a review
    // of the work that was objected to — and the changes went unread, cleared by
    // that stage starting.
    const events = store.eventsFor('t2');
    const settled = events.findIndex((e) => e.type === 'stage_finished');
    assert.equal(deriveTicket(events.slice(0, settled + 1)).status, 'implementing');
    assert.deepEqual(h.ran, ['implement', 'implement'], 'which is the run it bought');
  } finally {
    await h.close();
    store.close();
  }
});

test('nor onto one that was accepted while it ran', async () => {
  // The other way the wait can end mid-settle: a poll finds the pull request merged
  // on the host. Routed on the offer, the report walked a `done` ticket into a
  // review, a verify and a second pull request for work that had already landed.
  const store = openStore(':memory:');
  let answered = false;
  const h = clashingOffer({
    store,
    runStage: async () => {
      if (!answered) {
        answered = true;
        store.append('t2', { type: 'verdict', verdict: 'accepted' });
      }
      // Everything else this could go on to run says yes, so nothing but the routing
      // stops it: with the bug it reaches `open_pr`.
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.equal(store.ticket('t2').status, 'done', 'the answer is where the ticket stayed');
    assert.deepEqual(h.ran, ['implement'], 'the settle, and nothing after it');
    assert.deepEqual(h.prsOpened, [], 'no second pull request for work already merged');
  } finally {
    await h.close();
    store.close();
  }
});

test('nor onto one the code host says has been answered', async () => {
  // Pending when the pass looked, answered by the time the run came back. Pushing
  // now moves the branch past a change request, which is exactly what `readVerdict`
  // reads as having addressed it.
  let answered = false;
  const h = clashingOffer({
    verdict: (id) =>
      id === 't2' && answered ? { kind: 'rejected', reason: 'not this' } : { kind: 'pending' },
    runStage: async ({ stage }) => {
      // The answer is what happens next: a rejection buys a new plan. Parked there,
      // because the round after one is not what this is about.
      if (stage !== 'implement') return { outcome: 'blocked', summary: 'not what this is about' };
      answered = true;
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, [], 'nothing was pushed');
    assert.deepEqual(h.ran, ['implement', 'plan'], 'the rejection was read and acted on');
  } finally {
    await h.close();
  }
});

test('a ticket sent back while another one settles is left where it is', async () => {
  // The pass reads the offered branches once and then spends minutes settling the
  // first of them. By the time it reaches the third, that list can be minutes out
  // of date: a ticket sent back in between has a run of its own going, and merging
  // the base into a worktree an agent is writing in is not something to find out
  // about from the diff.
  const store = openStore(':memory:');
  const h = clashingOffer({
    store,
    runStage: async ({ ticket }) => {
      if (ticket.id !== 't2') return { outcome: 'blocked', summary: 'not what this is about' };
      store.append('t3', { type: 'changes_requested', changes: 'not like that' });
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    standing(store, 't3');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.equal(
      h.refreshed.filter((r) => r.id === 't3').length,
      1,
      'brought up to date by its own run, and not by the pass that had it as offered',
    );
  } finally {
    await h.close();
    store.close();
  }
});

test('a clash with work the ticket waited for is still the manager’s', async () => {
  // The dependency was theirs to choose, and settling it here would resolve one
  // ticket's work against another's on a branch neither of them is being built on.
  const h = harness({
    refresh: (id) =>
      id === 't2'
        ? { ...CLASH, with: 'wb/t3', paths: ['project/shared.py'] }
        : { kind: 'up-to-date' },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, [], 'nothing was run at it');
    assert.deepEqual(h.abandoned, ['t2'], 'and the merge kept for one is undone');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['project/shared.py']);
    assert.doesNotMatch(t2.question?.question ?? '', /resolution was tried/, 'because none was');
  } finally {
    await h.close();
  }
});

test('the manager can merge the offer here, and the ticket is done', async () => {
  const h = harness();
  try {
    standing(h.store, 't2');
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, ['https://example/pr/t1']);
    assert.equal(h.store.ticket('t1').status, 'done', 'the verdict is recorded here, not polled');
    assert.deepEqual(h.tidied, ['t1'], 'and the workspace goes with it');
    // The base has moved under everything else that is standing, exactly as it
    // would have if the merge had been done on GitHub.
    const refreshed = h.store.eventsFor('t2').filter((e) => e.type === 'refreshed');
    assert.equal(refreshed.length, 0, 'up to date here, but it was asked');
    assert.equal(h.store.ticket('t2').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('a merge onto a base that will not merge names the files and merges nothing', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/api/server.ts'],
      // Asked without `keep`, so the clash was found and undone rather than left.
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: false,
    }),
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, [], 'nothing is merged over a clash');
    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(ticket.conflicts, ['src/api/server.ts'], 'the panel can list them');
    assert.equal(ticket.mergeRequested, false, 'and it does not keep trying');
  } finally {
    await h.close();
  }
});

test('a merge the code host refuses parks the ticket rather than finishing it', async () => {
  const h = harness({
    merge: async () => {
      throw new Error('the base branch requires a review');
    },
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /requires a review/);
    assert.deepEqual(h.tidied, [], 'nothing was accepted, so nothing is thrown away');
  } finally {
    await h.close();
  }
});

/** One turn of the event loop, so anything that overlaps has the chance to. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('one pull request merges at a time, the pass over the others included', async () => {
  // Merging brings the new base into every other offered branch, one at a time. Two
  // merges at once put two of those passes in the same worktrees.
  const order: string[] = [];
  const h = harness({
    merge: async (id) => {
      order.push(`merge ${id}`);
      await turn();
    },
    discard: async (id) => {
      order.push(`pass after ${id}`);
      await turn();
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t2', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(order, ['merge t1', 'pass after t1', 'merge t2', 'pass after t2']);
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t2']);
    assert.equal(h.store.ticket('t1').status, 'done');
    assert.equal(h.store.ticket('t2').status, 'done');
  } finally {
    await h.close();
  }
});

test('a poll that finds three pull requests merged takes them one at a time', async () => {
  // No click is needed for the same pile-up: three merged on github.com between
  // polls used to start three passes over the same branches at once.
  const order: string[] = [];
  const h = harness({
    verdict: { kind: 'accepted' },
    discard: async (id) => {
      order.push(`enter ${id}`);
      await turn();
      order.push(`exit ${id}`);
    },
  });
  try {
    for (const id of ['t1', 't2', 't3']) standing(h.store, id);
    await h.orch.idle();

    assert.deepEqual(order, ['enter t1', 'exit t1', 'enter t2', 'exit t2', 'enter t3', 'exit t3']);
    for (const id of ['t1', 't2', 't3']) assert.equal(h.store.ticket(id).status, 'done');
  } finally {
    await h.close();
  }
});

test('a merge asked for while one is running waits, is told so, and then merges', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    merge: async (id) => {
      if (id === 't1') await held;
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t2', { type: 'merge_requested' });

    const before = h.store.eventsFor('t2').length;
    await h.orch.tick();
    await h.orch.tick();
    await h.orch.tick();

    assert.deepEqual(h.announced, ["t2 is queued behind t1's merge"], 'said once, not once a tick');
    assert.equal(h.store.eventsFor('t2').length, before, 'nothing is recorded while it waits');
    assert.equal(h.store.ticket('t2').mergeRequested, true, 'the request still stands');
    assert.deepEqual(h.prsMerged, [], 'and nothing of it has happened yet');

    release();
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t2']);
    assert.equal(h.store.ticket('t2').status, 'done', 'the queue drains on its own');
  } finally {
    release();
    await h.close();
  }
});

test('a merge left queued is still asked for after the workbench restarts', async () => {
  // The queue needs no state of its own: a merge asked for is a durable event, and
  // queuing is only this tick declining to act on it.
  const store = openStore(':memory:');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = harness({
    store,
    merge: async (id) => {
      if (id === 't1') await held;
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    store.append('t2', { type: 'merge_requested' });
    await first.orch.tick();

    assert.deepEqual(first.prsMerged, [], 'the first merge has not finished');
    assert.equal(store.ticket('t2').mergeRequested, true);
  } finally {
    release();
    await first.close();
  }

  const second = harness({ store });
  try {
    await second.orch.idle();

    assert.deepEqual(second.prsMerged, ['https://example/pr/t2'], 'picked up where it left off');
    assert.equal(store.ticket('t2').status, 'done');
  } finally {
    await second.close();
    store.close();
  }
});

test('work that conflicts with the base it must land on is not offered', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/domain/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: false,
    }),
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /src\/domain\/rules\.ts/, 'and says where');
    assert.deepEqual(h.prsOpened, [], 'nothing was offered against a base it cannot sit on');
  } finally {
    await h.close();
  }
});

test('a merge a stage stopped partway through is not tidied away by offering the work', async () => {
  // Left by a run that was handed the merge and stopped to ask something. Its half of
  // the resolution, and every uncommitted edit it made, are still sitting there: the
  // pass over the offered branches undoes a merge because it is the one that left it,
  // and nothing else may. A ticket shipped mid-resolution reaches here.
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/domain/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: true,
    }),
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.abandoned, [], 'the run’s work is where the run left it');
    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(ticket.conflicts, ['src/domain/rules.ts'], 'and the manager is asked');
    assert.deepEqual(h.prsOpened, [], 'over a branch that was not offered');
  } finally {
    await h.close();
  }
});

test('work that deletes what the base added is not offered', async () => {
  // Four branches in a row reverted the same dependency, and every reviewer read
  // the deletion as the ticket's own work.
  const anchors: (string | undefined)[] = [];
  const h = harness({
    removedFromBase: (_id, from) => {
      anchors.push(from);
      return ['project/deps.lock', 'project/vendor/sdk.py'];
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    const asked = ticket.question?.question ?? '';
    assert.match(asked, /project\/deps\.lock/);
    assert.match(asked, /project\/vendor\/sdk\.py/, 'every one of them, not the first');
    assert.match(asked, /put them back/, 'and what the ticket can do about it');
    assert.deepEqual(h.prsOpened, [], 'and nothing was offered');
    assert.deepEqual(ticket.conflicts, [], 'not a clash git has an opinion about');
    assert.deepEqual(anchors, ['abc1234'], 'measured from what the ticket is measured from');
  } finally {
    await h.close();
  }
});

test('a standing branch that reverts the base it is brought up to is parked too', async () => {
  // A resolution reverts as well as a merge does, so the pass over the other pull
  // requests after a merge asks the same question the first offer did.
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
    removedFromBase: (id) => (id === 't2' ? ['project/deps.lock'] : []),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'the one that reverted nothing');
    assert.equal(h.store.ticket('t1').status, 'done', 'offered and merged exactly as before');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.match(t2.question?.question ?? '', /project\/deps\.lock/, 'and says which file');
  } finally {
    await h.close();
  }
});

test('work the new base breaks is not offered either', async () => {
  let asked = 0;
  const h = harness({
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
    // Passing for the verify stage, failing once the base has been merged in: the
    // clash a merge resolves silently is the one worth finding.
    checks: () => [
      asked++ === 0
        ? { command: 'yarn test', ok: true, output: '' }
        : { command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' },
    ],
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /1 failing/, 'with the failure, not a summary');
    assert.equal(ticket.commits.at(-1), 'merge01', 'the merge is still on the branch');
    assert.deepEqual(h.prsOpened, []);
  } finally {
    await h.close();
  }
});
