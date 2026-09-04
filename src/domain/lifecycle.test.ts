import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Event, EventBody } from './events.ts';
import { needsYou } from './board.ts';
import { deriveTicket, type Ticket } from './ticket.ts';
import { DEFAULT_POLICY, nextAction, type Action } from './rules.ts';

/** Accumulates events for one ticket and re-derives it, the way the store will. */
class Journal {
  events: Event[] = [];
  ticketId = 't1';

  add(body: EventBody): Ticket {
    this.events.push({
      ...body,
      id: this.events.length + 1,
      ticketId: this.ticketId,
      at: '2026-08-03T00:00:00Z',
    });
    return this.ticket();
  }

  ticket(): Ticket {
    return deriveTicket(this.events);
  }

  /** What the orchestrator would do next, with no other tickets running. */
  next(running = 0): Action {
    return nextAction(this.ticket(), running, DEFAULT_POLICY);
  }
}

/** Written down and committed to, which is where every test below starts. */
function newTicket(): Journal {
  const j = new Journal();
  j.add({ type: 'ticket_created', title: 'do a thing', body: 'details' });
  j.add({ type: 'queued' });
  return j;
}

/** Run a stage to completion. `rejected` is how review and verify say no. */
function runStage(
  j: Journal,
  stage: 'plan' | 'implement' | 'review' | 'verify',
  opts: { summary?: string; rejected?: string; costUsd?: number; settling?: true } = {},
): Ticket {
  j.add({ type: 'stage_started', stage, runId: `r-${stage}` });
  return j.add({
    type: 'stage_finished',
    runId: `r-${stage}`,
    outcome: 'completed',
    summary: opts.summary ?? `${stage} done`,
    rejected: opts.rejected,
    costUsd: opts.costUsd,
    settling: opts.settling,
  });
}

/** One full trip: plan, approve, implement, then a review that says no. */
function rejectedCycle(j: Journal, why: string): Ticket {
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  runStage(j, 'implement');
  return runStage(j, 'review', { rejected: why });
}

test('a new ticket waits in the backlog until the manager commits to it', () => {
  const j = new Journal();
  j.add({ type: 'ticket_created', title: 'an idea', body: '' });

  assert.equal(j.ticket().status, 'backlog');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'the workbench never touches the backlog');

  j.add({ type: 'queued' });
  assert.equal(j.ticket().status, 'queued');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'plan' });
});

test('a ticket can be rewritten, one field at a time, wherever it has got to', () => {
  const j = newTicket();
  runStage(j, 'plan');

  const retitled = j.add({ type: 'ticket_edited', title: 'do a better thing' });
  assert.equal(retitled.title, 'do a better thing');
  assert.equal(retitled.body, 'details', 'what was not edited is left alone');
  assert.equal(retitled.status, 'plan_gate', 'rewriting it does not move it');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'and does not restart anything');

  const rewritten = j.add({ type: 'ticket_edited', body: 'much better details' });
  assert.equal(rewritten.title, 'do a better thing');
  assert.equal(rewritten.body, 'much better details');
});

test('comments send the work back to implement, not back to the drawing board', () => {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  runStage(j, 'implement');

  j.add({ type: 'stage_started', stage: 'review', runId: 'r-review' });
  const commented = j.add({
    type: 'stage_finished',
    runId: 'r-review',
    outcome: 'completed',
    summary: 'three things are wrong',
    changes: '- the headline claim contradicts table 2',
  });

  assert.equal(commented.status, 'implementing', 'the draft survives');
  assert.equal(commented.changes, '- the headline claim contradicts table 2');
  assert.equal(commented.revisions, 1);
  assert.equal(commented.rejection, null, 'this is not a rejection');
  assert.equal(commented.cycles, 1, 'and it costs no cycle');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });

  // Read into the brief once, by the stage that has to act on it.
  assert.equal(j.add({ type: 'stage_started', stage: 'implement', runId: 'r2' }).changes, null);
});

test('an objection that survives being addressed twice is about the approach', () => {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });

  const comment = (n: number) => {
    runStage(j, 'implement');
    j.add({ type: 'stage_started', stage: 'review', runId: `r${n}` });
    return j.add({
      type: 'stage_finished',
      runId: `r${n}`,
      outcome: 'completed',
      summary: 'still wrong',
      changes: 'the units are still wrong',
    });
  };

  assert.equal(comment(1).status, 'implementing');
  assert.equal(comment(2).status, 'implementing');

  const third = comment(3);
  assert.equal(third.status, 'planning', 'the third time, it is the approach');
  assert.match(third.rejection ?? '', /after 2 attempts to address it/);
  assert.equal(third.changes, null, 'nothing left for implement to act on');

  // A new plan is a new approach, so the count starts again.
  assert.equal(j.add({ type: 'stage_started', stage: 'plan', runId: 'r4' }).revisions, 0);
});

test('the manager can ship what a ticket has, whatever the agents made of it', () => {
  const j = newTicket();
  assert.equal(j.add({ type: 'shipped' }).status, 'queued', 'nothing to offer yet');

  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'abc1234',
  });
  j.add({ type: 'stage_started', stage: 'review', runId: 'r2' });
  const rejected = j.add({
    type: 'stage_finished',
    runId: 'r2',
    outcome: 'completed',
    summary: 'not good enough',
    rejected: 'it could be better',
  });
  assert.equal(rejected.status, 'planning', 'the loop would go round again');

  const shipped = j.add({ type: 'shipped' });
  assert.equal(shipped.status, 'ready_for_pr', 'the manager settles it instead');
  assert.deepEqual(j.next(), { kind: 'open_pr' });
});

test('shipping waits for a running stage rather than racing it', () => {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'abc1234',
  });

  // A stage in flight still reports back, and that report decides where the
  // ticket goes next — so it would undo the shipping.
  j.add({ type: 'stage_started', stage: 'review', runId: 'r2' });
  assert.equal(j.add({ type: 'shipped' }).status, 'reviewing', 'left alone while it runs');
});

test('the cycle cap hands the ticket over rather than binning it', () => {
  const j = newTicket();
  for (let i = 0; i < DEFAULT_POLICY.maxCycles; i++) {
    runStage(j, 'plan');
    j.add({ type: 'plan_approved' });
    runStage(j, 'implement');
    runStage(j, 'review', { rejected: 'still not good enough' });
  }

  const action = j.next();
  assert.equal(action.kind, 'hand_over', 'the agents cannot agree; the manager decides');
  assert.match(action.kind === 'hand_over' ? action.reason : '', /ship what is there/);
  assert.match(action.kind === 'hand_over' ? action.reason : '', /still not good enough/);
});

test('a stage that failed can be restarted, carrying nothing over', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  const crashed = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'failed',
    summary: 'the model service hung up',
    sessionId: 'abc',
  });

  assert.equal(crashed.status, 'blocked', 'a crash parks the ticket');
  assert.deepEqual(j.next(), { kind: 'wait' });

  const restarted = j.add({ type: 'stage_restarted' });
  assert.equal(restarted.status, 'implementing', 'back into the stage it died in');
  assert.equal(restarted.session, null, 'a conversation that died is not resumed');
  assert.equal(restarted.answer, null, 'and nothing is put in front of the agent');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });

  // Only a stuck ticket. A restart cannot reach into work that is going.
  assert.equal(j.add({ type: 'stage_restarted' }).status, 'implementing');
});

/** A stage that the workbench was stopped in the middle of, as `reconcile` closes it. */
function stoppedMidStage(
  j: Journal,
  stage: 'plan' | 'implement' | 'review',
  sessionId?: string,
): Ticket {
  j.add({ type: 'stage_started', stage, runId: 'r1' });
  if (sessionId !== undefined) j.add({ type: 'session_started', runId: 'r1', sessionId });
  return j.add({
    type: 'stage_finished',
    runId: 'interrupted',
    outcome: 'interrupted',
    summary: 'the workbench stopped while this stage was running',
    sessionId,
  });
}

test('the workbench being stopped is not the stage failing', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({ type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
  assert.equal(
    j.ticket().session,
    'sess-abc',
    'the conversation is written down while the run is still going, not when it ends',
  );

  const stopped = j.add({
    type: 'stage_finished',
    runId: 'interrupted',
    outcome: 'interrupted',
    summary: 'the workbench stopped while this stage was running',
    sessionId: 'sess-abc',
  });

  assert.equal(stopped.status, 'blocked', 'it parks, like anything else that is stuck');
  assert.equal(stopped.interrupted, true, 'and says which of the two it was');
  assert.equal(stopped.session, 'sess-abc', 'the run is still there to be carried on');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'but nothing picks it back up on its own');
});

test('continuing an interrupted stage keeps its conversation', () => {
  const j = newTicket();
  stoppedMidStage(j, 'implement', 'sess-abc');

  const carrying = j.add({ type: 'stage_continued' });
  assert.equal(carrying.status, 'implementing', 'back into the stage it stopped in');
  assert.equal(carrying.session, 'sess-abc', 'carrying what it had already thought');
  assert.equal(carrying.interrupted, false, 'and no longer waiting to be picked up');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });

  // Guarded like a restart: it cannot reach into work that is already going.
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r2' });
  assert.equal(j.add({ type: 'stage_continued' }).running, true, 'left alone while it runs');
});

test('a ticket blocked on a question is not one to carry on', () => {
  // `blocked` is two states and this is the other one: nothing was interrupted,
  // there is a question waiting for an answer. Carrying it on would clear the
  // question and resume the agent into its own unanswered one, told nothing was
  // wrong — the question, the box the manager types into, and the reply all lost.
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  j.add({
    type: 'question_asked',
    runId: 'r1',
    question: 'which config is live?',
    reasoning: 'two disagree',
  });
  const asked = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'blocked',
    summary: 'waiting on the manager',
    sessionId: 'sess-abc',
  });
  assert.equal(asked.status, 'blocked');
  assert.equal(asked.interrupted, false, 'stopped by its own question, not by the workbench');

  const unmoved = j.add({ type: 'stage_continued' });
  assert.deepEqual(unmoved, asked, 'so the move leaves it exactly as it was');
  assert.equal(unmoved.question?.question, 'which config is live?', 'still to be answered');
  assert.equal(unmoved.status, 'blocked');
  assert.equal(unmoved.session, 'sess-abc', 'and still there for the answer to resume');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'nothing runs it in the meantime');
});

test('restarting an interrupted stage still throws the conversation away', () => {
  const j = newTicket();
  stoppedMidStage(j, 'implement', 'sess-abc');

  const restarted = j.add({ type: 'stage_restarted' });
  assert.equal(restarted.status, 'implementing');
  assert.equal(restarted.session, null, 'from the top means from the top');
  assert.equal(restarted.interrupted, false, 'and it is no longer one to pick back up');
});

test('a stage stopped before it had a conversation can still be continued', () => {
  // Killed between the run starting and the model service naming it. There is
  // nothing to resume, and the ticket must still be offered and still move —
  // otherwise the one thing this must never do, lose a ticket, is what it does.
  const j = newTicket();
  const stopped = stoppedMidStage(j, 'plan');
  assert.equal(stopped.interrupted, true, 'still one to pick back up');
  assert.equal(stopped.session, null, 'with nothing to pick up from');

  assert.equal(j.add({ type: 'stage_continued' }).status, 'planning');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'plan' }, 'so it runs from the top');
});

/** Blocked mid-review, holding that review's conversation, with work committed. */
function parkedMidReview(): Journal {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r-impl' });
  j.add({
    type: 'stage_finished',
    runId: 'r-impl',
    outcome: 'completed',
    summary: 'built',
    commit: 'c1',
  });
  j.add({ type: 'stage_started', stage: 'review', runId: 'r-review' });
  j.add({
    type: 'stage_finished',
    runId: 'r-review',
    outcome: 'blocked',
    summary: 'waiting on the manager',
    sessionId: 'sess-review',
  });
  return j;
}

test('a move that is not back to the parked run leaves its conversation behind', () => {
  // The stage about to run resumes whatever session it finds and nothing else, so
  // one kept past the move that went elsewhere is the wrong conversation picked up
  // with the wrong prompt: the review's chat told the workbench had stopped, and
  // what the manager actually asked for never delivered at all.
  assert.equal(parkedMidReview().ticket().session, 'sess-review', 'there is one to leave');

  for (const move of [
    { type: 'plan_approved' },
    { type: 'plan_rejected', reason: 'wrong shape' },
    { type: 'changes_requested', changes: 'put the units right' },
    { type: 'shipped' },
  ] as const) {
    assert.equal(parkedMidReview().add(move).session, null, `${move.type} kept the review's`);
  }

  const changed = parkedMidReview().add({
    type: 'changes_requested',
    changes: 'put the units right',
  });
  assert.equal(changed.status, 'implementing');
  assert.equal(changed.changes, 'put the units right', 'which is how the ask gets delivered');

  // And the long way round to the same place: shipped, offered, and turned down.
  const j = parkedMidReview();
  assert.equal(j.add({ type: 'shipped' }).status, 'ready_for_pr');
  j.add({ type: 'pr_opened', url: 'https://example.test/pr/1' });
  const rejected = j.add({ type: 'verdict', verdict: 'rejected', reason: 'not what I asked for' });
  assert.equal(rejected.status, 'planning');
  assert.equal(rejected.session, null, 'the plan that answers this is not the review that stopped');
});

test('a ticket picked up some other way stops asking to be picked up', () => {
  // Stopped mid-review, and the manager ships the work rather than carrying the
  // run on. A flag that outlives what it describes is a modal that comes back
  // every load, offering a button `stage_continued` will decline to act on.
  const j = parkedMidReview();
  assert.equal(stoppedMidStage(j, 'review', 'sess-abc').interrupted, true);

  const shipped = j.add({ type: 'shipped' });
  assert.equal(shipped.status, 'ready_for_pr');
  assert.equal(shipped.interrupted, false, 'shipping it is what became of it instead');
  assert.equal(j.add({ type: 'pr_opened', url: 'https://example.test/pr/1' }).interrupted, false);

  // Answering it is picking it up too, by the other of the two doors that go back
  // to the run — so that one keeps the conversation and drops the flag.
  const a = newTicket();
  stoppedMidStage(a, 'implement', 'sess-def');
  const answered = a.add({ type: 'question_answered', answer: 'the one in etc/' });
  assert.equal(answered.interrupted, false, 'it has just been picked back up');
  assert.equal(answered.session, 'sess-def', 'by the door that goes back to it');
});

test('the plan carries the steps, and a new plan drops the old ones', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  const planned = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'the plan',
    steps: ['Read the code', 'Change it', 'Test it'],
  });
  assert.deepEqual(planned.steps, ['Read the code', 'Change it', 'Test it']);

  j.add({ type: 'plan_approved' });
  const working = j.add({ type: 'stage_started', stage: 'implement', runId: 'r2' });
  assert.deepEqual(working.steps, ['Read the code', 'Change it', 'Test it'], 'the plan stands');
  assert.equal(working.step, null, 'a stage that has just started has made no progress');

  assert.equal(j.add({ type: 'step_reached', runId: 'r2', index: 2 }).step, 2);

  // A new plan re-decides the work, so the old steps go with the old plan.
  assert.deepEqual(j.add({ type: 'stage_started', stage: 'plan', runId: 'r3' }).steps, []);
});

test('completion criteria written under the old key still reach the ticket', () => {
  // Events are stored as JSON and replayed on every read, so a ticket planned
  // before the rename still carries its criteria under `doneWhen`.
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  const planned = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'the plan',
    doneWhen: ['every number matches calcs_v03.py'],
  } as EventBody);

  assert.deepEqual(planned.completionCriteria, ['every number matches calcs_v03.py']);
});

test('a ticket can go back to the backlog, but only before it starts', () => {
  const j = newTicket();

  assert.equal(j.add({ type: 'backlogged' }).status, 'backlog');
  j.add({ type: 'queued' });

  runStage(j, 'plan');
  assert.equal(j.add({ type: 'backlogged' }).status, 'plan_gate', 'work already done stays');
});

test('happy path: created to merged', () => {
  const j = newTicket();

  const planned = runStage(j, 'plan', { summary: 'the plan' });
  assert.equal(planned.status, 'plan_gate');
  assert.equal(planned.plan, 'the plan', 'the gate shows the plan run summary');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'the gate waits for the manager');

  j.add({ type: 'plan_approved' });
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });

  runStage(j, 'implement');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'review' });

  runStage(j, 'review');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'verify' });

  const verified = runStage(j, 'verify');
  assert.equal(verified.status, 'ready_for_pr');
  assert.deepEqual(j.next(), { kind: 'open_pr' });

  j.add({ type: 'pr_opened', url: 'https://example/pr/1' });
  assert.deepEqual(j.next(), { kind: 'poll_verdict' });

  const done = j.add({ type: 'verdict', verdict: 'accepted' });
  assert.equal(done.status, 'done');
  assert.equal(done.prUrl, 'https://example/pr/1', 'the record of where the work went');
  assert.deepEqual(j.next(), { kind: 'wait' });
});

/** Offered and waiting on the manager, which is where a merge is asked for. */
function offeredTicket(): Journal {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  runStage(j, 'implement');
  runStage(j, 'review');
  runStage(j, 'verify');
  j.add({ type: 'pr_opened', url: 'https://example/pr/7' });
  return j;
}

test('the manager can ask for the merge here, and it is done once', () => {
  const j = offeredTicket();
  assert.deepEqual(j.next(), { kind: 'poll_verdict' });

  const asked = j.add({ type: 'merge_requested' });
  assert.equal(asked.mergeRequested, true);
  assert.equal(asked.mergeMethod, 'squash', 'a request that names no method squashes');
  assert.deepEqual(j.next(), { kind: 'merge_pr' }, 'an answer given is not one to poll for');

  const merged = j.add({ type: 'verdict', verdict: 'accepted' });
  assert.equal(merged.status, 'done');
  assert.equal(merged.mergeRequested, false, 'nothing is left asking to be merged again');
  assert.equal(merged.mergeMethod, null, 'and no method left over from the one that happened');
  assert.deepEqual(j.next(), { kind: 'wait' });
});

test('the manager can ask for a merge commit instead of a squash', () => {
  const j = offeredTicket();

  const asked = j.add({ type: 'merge_requested', method: 'merge' });
  assert.equal(asked.mergeRequested, true);
  assert.equal(asked.mergeMethod, 'merge', 'the choice is carried to whoever does the merging');

  // The method is a fact about one request, so nothing that ends the request keeps it.
  const stuck = j.add({
    type: 'blocked',
    reason: 'it conflicts',
    conflicts: ['src/api/server.ts'],
  });
  assert.equal(stuck.mergeMethod, null);
});

test('a merge that cannot happen names the files and stops asking', () => {
  const j = offeredTicket();
  j.add({ type: 'merge_requested' });

  const stuck = j.add({
    type: 'blocked',
    reason: 'this branch conflicts with the base',
    conflicts: ['src/api/server.ts', 'ui/src/Detail.tsx'],
  });
  assert.equal(stuck.status, 'blocked');
  assert.deepEqual(stuck.conflicts, ['src/api/server.ts', 'ui/src/Detail.tsx']);
  assert.equal(stuck.mergeRequested, false, 'a merge that failed is not retried by itself');
  assert.deepEqual(j.next(), { kind: 'wait' });

  // The way out: back to implement to resolve them, which is where the paths stop
  // being true — they are a fact about the branch as it was.
  const back = j.add({ type: 'changes_requested', changes: 'resolve the conflicts' });
  assert.equal(back.status, 'implementing');
  assert.equal(back.mergeRequested, false);
  assert.deepEqual(back.conflicts, ['src/api/server.ts', 'ui/src/Detail.tsx'], 'until it starts');

  const started = j.add({ type: 'stage_started', stage: 'implement', runId: 'r-fix' });
  assert.deepEqual(started.conflicts, []);
});

test('the conflicting paths last no longer than the clash does', () => {
  // A stage starting was once the only thing that cleared them, so a ticket that
  // got past the clash any other way went on listing files it no longer disagreed
  // about — a merged one included, where the panel offered to send it back.
  const stuck = (): Journal => {
    const j = offeredTicket();
    j.add({ type: 'merge_requested' });
    j.add({ type: 'blocked', reason: 'it conflicts', conflicts: ['src/api/server.ts'] });
    return j;
  };

  const merged = stuck().add({ type: 'verdict', verdict: 'accepted' });
  assert.deepEqual(merged.conflicts, [], 'the merge is what settled them');

  const answered = stuck().add({ type: 'question_answered', answer: 'merged it by hand' });
  assert.deepEqual(answered.conflicts, [], 'back to the wait, with the clash dealt with');

  const restarted = stuck().add({ type: 'stage_restarted' });
  assert.deepEqual(restarted.conflicts, []);

  const refreshed = stuck().add({ type: 'refreshed', base: 'aaaa111', commit: 'bbbb222' });
  assert.deepEqual(refreshed.conflicts, [], 'the base went in cleanly this time');
});

test('a run that settled a clash on an offered branch goes back to the wait', () => {
  // The one stage that runs while a pull request is standing: the workbench settling
  // a clash the base brought. There is no next stage to route it to — review and
  // verify have passed on this work already — and going round again would arrive at
  // `ready_for_pr` for a branch that has had a pull request all along.
  const j = offeredTicket();
  const settled = runStage(j, 'implement', { summary: 'took both sides', settling: true });

  assert.equal(settled.status, 'awaiting_verdict');
  assert.equal(settled.offered, true, 'the offer never ended');
  assert.deepEqual(j.next(), { kind: 'poll_verdict' }, 'still waiting on the manager');

  // A settling run that did not land says nothing about where the ticket goes
  // either: the pass that asked for it appends the `blocked` event, with the paths
  // and what the attempt left, and that is what parks it.
  const k = offeredTicket();
  k.add({ type: 'stage_started', stage: 'implement', runId: 'r-settle' });
  const left = k.add({
    type: 'stage_finished',
    runId: 'r-settle',
    outcome: 'blocked',
    summary: 'src/api/server.ts is still conflicted',
    settling: true,
  });
  assert.equal(left.status, 'awaiting_verdict', 'not this run’s to decide');
  const parked = k.add({
    type: 'blocked',
    reason: 'it conflicts',
    conflicts: ['src/api/server.ts'],
  });
  assert.equal(parked.status, 'blocked', 'the pass is what parks it');

  // And a run that was a genuine stage still parks it where it stands: an offer
  // standing is not a reason to say nothing about work the workbench could not
  // finish.
  const m = offeredTicket();
  m.add({ type: 'stage_started', stage: 'implement', runId: 'r-stage' });
  const stuck = m.add({
    type: 'stage_finished',
    runId: 'r-stage',
    outcome: 'blocked',
    summary: 'src/api/server.ts is still conflicted',
  });
  assert.equal(stuck.status, 'blocked');
});

test('an answer that lands while a clash is settled is what the ticket keeps', () => {
  // The offered branches are read once and then settled one at a time, an agent run
  // each. In those minutes the manager can answer the pull request — and every way
  // of answering it ends the offer, so routing the report on `offered` missed and
  // walked it on into a review instead: the requested changes dropped at the next
  // `stage_started`, and accepted work sent round again for a second pull request.
  const settling = (answer: EventBody): Journal => {
    const j = offeredTicket();
    j.add({ type: 'stage_started', stage: 'implement', runId: 'r-settle' });
    j.add(answer);
    j.add({
      type: 'stage_finished',
      runId: 'r-settle',
      outcome: 'completed',
      summary: 'took both sides',
      settling: true,
    });
    return j;
  };

  const changed = settling({ type: 'changes_requested', changes: 'not like that' }).ticket();
  assert.equal(changed.status, 'implementing');
  assert.equal(changed.changes, 'not like that', 'for the run that has to act on it');

  const rejected = settling({ type: 'plan_rejected', reason: 'wrong approach' }).ticket();
  assert.equal(rejected.status, 'planning');

  const accepted = settling({ type: 'verdict', verdict: 'accepted' });
  assert.equal(accepted.ticket().status, 'done');
  assert.deepEqual(accepted.next(), { kind: 'wait' }, 'and nothing offers it a second time');
});

test('merged work can be sent back to be tweaked, and buys a plan for the tweak', () => {
  // Done was the end of the road: a ticket that merged and then wanted a small
  // change had to be written out again as a new one, describing the old one first.
  const j = offeredTicket();
  const done = j.add({ type: 'verdict', verdict: 'accepted' });
  assert.equal(done.status, 'done');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'nothing picks it up again by itself');

  const tweaking = j.add({ type: 'plan_rejected', reason: 'the summary line should be shorter' });
  assert.equal(tweaking.status, 'planning');
  assert.equal(tweaking.rejection, 'the summary line should be shorter');
  // The offer is over, so nothing polls the pull request the work already merged
  // through and reads that merge as a verdict on the tweak.
  assert.equal(tweaking.offered, false);
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'plan' });

  // And the tweak survives into the run that has to act on it — which is what the
  // brief reads, the same as for any other objection.
  assert.equal(
    j.add({ type: 'stage_started', stage: 'plan', runId: 'r-plan-2' }).rejection,
    'the summary line should be shorter',
  );
});

test('restarting a ticket whose pull request is open resumes the verdict, not the stages', () => {
  // t32: the poll failed while the work sat in a pull request, and the restart put
  // the ticket back into verify. It came round to `ready_for_pr` a second time and
  // blocked on `gh pr create` for a branch GitHub already had a pull request for —
  // twice, with the work complete and correct throughout.
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  runStage(j, 'implement');
  runStage(j, 'review');
  runStage(j, 'verify');
  j.add({ type: 'pr_opened', url: 'https://example/pr/46' });

  const stuck = j.add({ type: 'blocked', reason: 'could not reach github' });
  assert.equal(stuck.status, 'blocked');

  const restarted = j.add({ type: 'stage_restarted' });
  assert.equal(restarted.status, 'awaiting_verdict', 'there is no stage left to restart');
  assert.equal(restarted.question, null, 'and nothing is still waiting on the manager');
  assert.equal(restarted.prUrl, 'https://example/pr/46');
  assert.deepEqual(j.next(), { kind: 'poll_verdict' }, 'it asks again rather than rebuilding');
});

test('answering a ticket whose pull request is open resumes the verdict, not the stages', () => {
  // t61, and the same mistake as t32 by the other door: the poll failed, the board
  // offered "try gh again", and answering it re-ran a verify stage that had already
  // passed and cost a dollar to pass. The wait it came back to afterwards was the
  // one it had never actually left.
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  runStage(j, 'implement');
  runStage(j, 'review');
  runStage(j, 'verify');
  j.add({ type: 'pr_opened', url: 'https://example/pr/92' });
  j.add({ type: 'blocked', reason: 'could not reach github' });

  const answered = j.add({ type: 'question_answered', answer: 'try gh again' });

  assert.equal(answered.status, 'awaiting_verdict', 'there is no stage left to resume');
  assert.equal(answered.answer, null, 'and nothing to carry into one');
  assert.deepEqual(j.next(), { kind: 'poll_verdict' }, 'it asks again rather than rebuilding');
});

test('the manager can send offered work back, or keep it and ask for changes', () => {
  const offered = (): Journal => {
    const j = newTicket();
    runStage(j, 'plan');
    j.add({ type: 'plan_approved' });
    j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
    j.add({
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'wrote it',
      commit: 'abc1234',
    });
    j.add({ type: 'pr_opened', url: 'https://example/pr/9' });
    return j;
  };

  // The expensive no: the approach is wrong, so it buys a whole new plan.
  const replanned = offered().add({ type: 'plan_rejected', reason: 'wrong approach' });
  assert.equal(replanned.status, 'planning');
  assert.equal(replanned.rejection, 'wrong approach');

  // The cheap one: the approach is right and the details are not, so the work
  // stands and goes back to be finished.
  const fixing = offered().add({ type: 'changes_requested', changes: '- the units are wrong' });
  assert.equal(fixing.status, 'implementing');
  assert.equal(fixing.changes, '- the units are wrong');

  // Both keep the pull request and both end the offer — which is what makes the
  // ticket shippable and restartable again while it is being put right.
  for (const t of [replanned, fixing]) {
    assert.equal(t.prUrl, 'https://example/pr/9');
    assert.equal(t.offered, false);
    assert.equal(t.running, false);
  }
});

test('the manager asking for changes is not rationed the way an agent is', () => {
  // MAX_REVISIONS exists because two agents repeating an objection is evidence
  // about the approach. A manager repeating one is just the manager, and turning
  // their third request into a re-plan would be the workbench overruling them.
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });

  for (let i = 0; i < 5; i++) {
    const asked = j.add({ type: 'changes_requested', changes: `round ${i}` });
    assert.equal(asked.status, 'implementing', `request ${i} still goes to implement`);
    assert.equal(asked.revisions, 0, 'and counts no revision against the plan');
  }
});

test('a stage that fails during a rework restarts as a stage, not as a wait', () => {
  // The ticket still has its pull request, so a restart that read `prUrl` would
  // drop it back into a verdict it is no longer waiting for.
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({ type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: 'x', commit: 'a1' });
  j.add({ type: 'pr_opened', url: 'https://example/pr/9' });
  j.add({ type: 'changes_requested', changes: 'fix the units' });

  j.add({ type: 'stage_started', stage: 'implement', runId: 'r2' });
  const died = j.add({
    type: 'stage_finished',
    runId: 'r2',
    outcome: 'failed',
    summary: 'crashed',
  });
  assert.equal(died.status, 'blocked');

  assert.equal(j.add({ type: 'stage_restarted' }).status, 'implementing');
});

test('a rejected pull request stops being the offer, so the rework can be offered again', () => {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'abc1234',
  });
  j.add({ type: 'pr_opened', url: 'https://example/pr/2' });

  const sentBack = j.add({ type: 'verdict', verdict: 'rejected', reason: 'use the helper' });
  assert.equal(sentBack.status, 'planning');
  assert.equal(sentBack.offered, false, 'the offer no longer stands');

  // The pull request itself does stay: the branch keeps it, the rework is pushed
  // to that same one, and it is where the objection being answered was written —
  // so the link is worth most exactly while the ticket is being put right.
  assert.equal(sentBack.prUrl, 'https://example/pr/2');

  // With the offer still standing, neither of the two ways back to a pull request
  // would work: the manager could not ship the ticket and could not restart it.
  assert.equal(j.add({ type: 'shipped' }).status, 'ready_for_pr');
  assert.deepEqual(j.next(), { kind: 'open_pr' }, 'offered again, on the same branch');
});

test('every rejection goes back to planning, carrying its reason', () => {
  // 1. the manager rejects the plan at the gate
  const gate = newTicket();
  runStage(gate, 'plan');
  const sentBack = gate.add({ type: 'plan_rejected', reason: 'wrong problem' });
  assert.equal(sentBack.status, 'planning');
  assert.equal(sentBack.rejection, 'wrong problem');
  assert.deepEqual(gate.next(), { kind: 'run_stage', stage: 'plan' });

  // 2. the review does not approve
  const review = newTicket();
  runStage(review, 'plan');
  review.add({ type: 'plan_approved' });
  runStage(review, 'implement');
  const reviewed = runStage(review, 'review', { rejected: 'races on retry' });
  assert.equal(reviewed.status, 'planning');
  assert.equal(reviewed.rejection, 'races on retry');

  // 3. the checks fail
  const verify = newTicket();
  runStage(verify, 'plan');
  verify.add({ type: 'plan_approved' });
  runStage(verify, 'implement');
  runStage(verify, 'review');
  const failed = runStage(verify, 'verify', { rejected: '2 tests failing' });
  assert.equal(failed.status, 'planning');
  assert.equal(failed.rejection, '2 tests failing');

  // 4. the manager requests changes on the pull request
  const pr = newTicket();
  runStage(pr, 'plan');
  pr.add({ type: 'plan_approved' });
  runStage(pr, 'implement');
  runStage(pr, 'review');
  runStage(pr, 'verify');
  pr.add({ type: 'pr_opened', url: 'https://example/pr/2' });
  const changes = pr.add({
    type: 'verdict',
    verdict: 'rejected',
    reason: 'use the existing helper',
  });
  assert.equal(changes.status, 'planning');
  assert.equal(changes.rejection, 'use the existing helper');
});

test('a question blocks the ticket and resumes the stage it left', () => {
  const j = newTicket();
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });

  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'question_asked',
    runId: 'r1',
    question: 'which of the two config files is live?',
    reasoning: 'both are referenced and they disagree',
  });
  const blocked = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'blocked',
    summary: 'waiting on the manager',
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.question?.question, 'which of the two config files is live?');
  assert.deepEqual(j.next(), { kind: 'wait' });

  const answered = j.add({ type: 'question_answered', answer: 'the one in etc/' });
  assert.equal(answered.status, 'implementing', 'resumes the stage it left');
  assert.equal(answered.question, null);
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });
});

test('a failed run parks the ticket, it does not count as a rejection', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  const dead = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'failed',
    summary: 'the process died',
  });

  assert.equal(dead.status, 'blocked');
  assert.equal(dead.rejection, null, 'a crash sets no rejection reason');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'it waits rather than retrying itself');
});

test('the work-in-progress limit holds a ticket back', () => {
  const j = newTicket();
  assert.deepEqual(j.next(2), { kind: 'wait' }, 'at the limit');
  assert.deepEqual(j.next(1), { kind: 'run_stage', stage: 'plan' }, 'below it');
});

test('a ticket with a run in flight is never started twice', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  assert.equal(j.ticket().running, true);
  assert.deepEqual(j.next(), { kind: 'wait' });
});

test('a ticket that keeps coming back is eventually handed to the manager', () => {
  const j = newTicket();

  for (let cycle = 1; cycle < DEFAULT_POLICY.maxCycles; cycle++) {
    const back = rejectedCycle(j, `attempt ${cycle} was wrong`);
    assert.equal(back.status, 'planning');
    assert.equal(back.cycles, cycle);
    assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'plan' }, 'still worth another go');
  }

  const last = rejectedCycle(j, 'and again');
  assert.equal(last.cycles, DEFAULT_POLICY.maxCycles);

  const action = j.next();
  assert.equal(action.kind, 'hand_over', 'not the bin: the agents cannot agree');
  assert.match(action.kind === 'hand_over' ? action.reason : '', /planned 3 times/);

  const waiting = j.add({ type: 'blocked', reason: 'planned 3 times' });
  assert.equal(waiting.status, 'blocked');
  assert.deepEqual(j.next(), { kind: 'wait' }, 'and it waits for the manager');
});

test('a ticket on its last cycle may still finish that cycle', () => {
  const j = newTicket();
  for (let cycle = 1; cycle < DEFAULT_POLICY.maxCycles; cycle++) {
    rejectedCycle(j, 'no');
  }
  runStage(j, 'plan');
  j.add({ type: 'plan_approved' });

  assert.equal(j.ticket().cycles, DEFAULT_POLICY.maxCycles);
  assert.deepEqual(
    j.next(),
    { kind: 'run_stage', stage: 'implement' },
    'the cap is on planning again, not on finishing what was planned',
  );
});

test('spending adds up across stages, and stops the ticket when it runs out', () => {
  const j = newTicket();

  runStage(j, 'plan', { costUsd: 1.5 });
  assert.equal(j.ticket().costUsd, 1.5);
  j.add({ type: 'plan_approved' });

  runStage(j, 'implement', { costUsd: DEFAULT_POLICY.maxTicketUsd });
  assert.equal(j.ticket().costUsd, DEFAULT_POLICY.maxTicketUsd + 1.5);

  const action = j.next();
  assert.equal(action.kind, 'give_up', 'the next stage never starts');
  assert.match(action.kind === 'give_up' ? action.reason : '', /\$51\.50/);
});

test('a run that reports no cost is free rather than unpriced', () => {
  const j = newTicket();
  runStage(j, 'plan');
  assert.equal(j.ticket().costUsd, 0, 'a missing cost must not make the total NaN');
});

test('a cancelled ticket stops, whatever it was doing', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });

  const stopped = j.add({ type: 'cancelled', reason: 'no longer wanted' });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.running, false, 'it no longer holds a work-in-progress slot');
  assert.deepEqual(j.next(), { kind: 'wait' });
});

test('nothing parks a ticket that has already ended', () => {
  const j = newTicket();
  j.add({ type: 'cancelled', reason: 'no longer wanted' });

  const late = j.add({ type: 'blocked', reason: 'this branch conflicts with the base' });
  assert.equal(late.status, 'cancelled', 'a stopped ticket does not come back as a question');
  assert.equal(late.question, null);
});

test('deriveTicket refuses an event list that does not start with creation', () => {
  assert.throws(
    () => deriveTicket([{ type: 'plan_approved', id: 1, ticketId: 't1', at: 'now' }]),
    /ticket_created/,
  );
});

test('the scale the plan declared reaches every later stage, and no stage is skipped', () => {
  const j = newTicket();
  assert.equal(j.ticket().scale, 'standard', 'a ticket starts at standard');

  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  const planned = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'a two-line change',
    scale: 'small',
  });
  assert.equal(planned.scale, 'small', 'the gate shows what the plan judged');

  // The whole point: small changes the depth asked of each stage, never the sequence.
  j.add({ type: 'plan_approved' });
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });
  runStage(j, 'implement');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'review' }, 'review still runs');
  runStage(j, 'review');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'verify' }, 'verify still runs');
  assert.equal(j.ticket().scale, 'small', 'and they are all told the same thing');
});

test('a re-plan judges the size again rather than inheriting the last answer', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'small at first glance',
    scale: 'small',
  });
  assert.equal(j.ticket().scale, 'small');

  // Round again. A stale "small" must not outlive the plan that justified it.
  j.add({ type: 'plan_rejected', reason: 'this is bigger than you think' });
  assert.equal(j.add({ type: 'stage_started', stage: 'plan', runId: 'r2' }).scale, 'standard');
});

test('a stage that stops to ask keeps its conversation, so the answer can carry on', () => {
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  j.add({
    type: 'question_asked',
    runId: 'r1',
    question: 'which config is live?',
    reasoning: 'two disagree',
  });
  const blocked = j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'blocked',
    summary: 'waiting on the manager',
    sessionId: 'sess-abc',
  });

  assert.equal(blocked.session, 'sess-abc', 'there is something to come back to');

  const answered = j.add({ type: 'question_answered', answer: 'the one in etc/' });
  assert.equal(answered.session, 'sess-abc', 'and the answer does not throw it away');
  assert.equal(answered.answer, 'the one in etc/');
});

test('a run that ends with nothing left to say leaves no conversation to resume', () => {
  // A stale id would invite resuming a conversation that has already finished,
  // and the manager would be answering a question nobody is waiting on.
  const j = newTicket();
  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'blocked',
    summary: 'waiting',
    sessionId: 'sess-abc',
  });
  assert.equal(j.ticket().session, 'sess-abc');

  j.add({ type: 'stage_started', stage: 'plan', runId: 'r2' });
  const finished = j.add({
    type: 'stage_finished',
    runId: 'r2',
    outcome: 'completed',
    summary: 'the plan',
  });
  assert.equal(finished.session, null, 'the stage finished; there is nothing to resume');
});

test('a ticket keeps its own git record: branch, base, commits, pull request', () => {
  const j = newTicket();
  j.add({ type: 'branched', branch: 'wb/t1', base: 'base1234' });

  j.add({ type: 'stage_started', stage: 'plan', runId: 'r1' });
  // Planning changes nothing on disk, so it commits nothing.
  j.add({ type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: 'the plan' });
  j.add({ type: 'plan_approved' });

  j.add({ type: 'stage_started', stage: 'implement', runId: 'r2' });
  j.add({
    type: 'stage_finished',
    runId: 'r2',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'c0ffee12',
  });

  const t = j.add({ type: 'pr_opened', url: 'https://example/pr/1' });

  assert.equal(t.branch, 'wb/t1');
  assert.equal(t.base, 'base1234', 'where the work started, so it can be placed later');
  assert.deepEqual(t.commits, ['c0ffee12'], 'only stages that changed something');
  assert.equal(t.prUrl, 'https://example/pr/1');
});

test('a branch keeps its base while it is carrying work the base has not got', () => {
  const j = newTicket();
  j.add({ type: 'branched', branch: 'wb/t1', base: 'base1234' });

  // The merge made as the branch was cut: the base plus the work it waited for and
  // nothing of its own, which is the only commit anywhere its own work can be
  // measured from.
  const took = j.add({
    type: 'refreshed',
    base: 'merge01',
    commit: 'merge01',
    took: ['wb/t2'],
    carrying: ['wb/t2'],
  });
  assert.equal(took.base, 'merge01');
  assert.deepEqual(took.carrying, ['wb/t2']);

  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'c0ffee12',
  });

  // t2 has been sent back for changes, so it is not offered and this refresh takes
  // nothing from it. Its merge is in the branch all the same — moving the base onto
  // a commit without it would hand a reviewer t2's whole change as this ticket's.
  const held = j.add({
    type: 'refreshed',
    base: 'newbase',
    commit: 'merge02',
    took: [],
    carrying: ['wb/t2'],
  });
  assert.equal(held.base, 'merge01', 'the base stands where the merge that took t2 put it');
  assert.deepEqual(
    held.commits,
    ['merge01', 'c0ffee12', 'merge02'],
    'the new base is in the branch anyway',
  );

  // And once t2's pull request is merged its work is in the base, so this branch is
  // carrying nothing the base has not got and its base moves again.
  const landed = j.add({ type: 'refreshed', base: 'newer001', commit: 'merge03', carrying: [] });
  assert.equal(landed.base, 'newer001');
  assert.deepEqual(landed.carrying, []);
});

test('a refresh recorded before branches were carried means what it always did', () => {
  const j = newTicket();
  j.add({ type: 'branched', branch: 'wb/t1', base: 'base1234' });

  const took = j.add({ type: 'refreshed', base: 'merge01', commit: 'merge01', took: ['wb/t2'] });
  assert.equal(took.base, 'merge01');
  assert.deepEqual(took.carrying, ['wb/t2'], 'what it took is what it was carrying');

  j.add({ type: 'stage_started', stage: 'implement', runId: 'r1' });
  j.add({
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'wrote it',
    commit: 'c0ffee12',
  });

  const still = j.add({ type: 'refreshed', base: 'newbase', commit: 'merge02', took: ['wb/t2'] });
  assert.equal(still.base, 'merge01', 'held by what it took, exactly as before');

  const plain = j.add({ type: 'refreshed', base: 'newer001', commit: 'merge03' });
  assert.equal(plain.base, 'newer001', 'and an ordinary refresh moves it, as it always did');
});

test('a ticket written without a gate builds what it plans', () => {
  const j = new Journal();
  j.add({ type: 'ticket_created', title: 'do a thing', body: 'details', requiresApproval: false });
  j.add({ type: 'queued' });

  const planned = runStage(j, 'plan', { summary: 'the plan' });

  assert.equal(planned.status, 'implementing', 'it does not stop to be approved');
  assert.equal(planned.plan, 'the plan', 'and the plan is still recorded');
  assert.equal(needsYou(planned), false, 'nothing is waiting on the manager');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'implement' });

  // Only the gate moves. Everything after it is the same ticket it always was.
  runStage(j, 'implement');
  assert.deepEqual(j.next(), { kind: 'run_stage', stage: 'review' });
});

test('the gate is what a ticket was written with, and the default is to have one', () => {
  const gated = newTicket();
  assert.equal(gated.ticket().requiresApproval, true, 'saying nothing means the gate stays');
  assert.equal(runStage(gated, 'plan').status, 'plan_gate');

  // A re-plan does not lose it: the gate belongs to the ticket, not to the run.
  gated.add({ type: 'plan_rejected', reason: 'wrong problem' });
  assert.equal(runStage(gated, 'plan').status, 'plan_gate');

  // Nor does rewriting the ticket, when the rewrite says nothing about the gate.
  gated.add({ type: 'ticket_edited', title: 'do a better thing' });
  assert.equal(gated.ticket().requiresApproval, true);
});

test('the gate can be taken off, and put back, any time before the plan is finished', () => {
  const j = newTicket();
  j.add({ type: 'ticket_edited', requiresApproval: false });
  assert.equal(j.ticket().requiresApproval, false);
  assert.equal(j.ticket().title, 'do a thing', 'saying only that leaves the words alone');

  j.add({ type: 'queued' });
  assert.equal(runStage(j, 'plan', { summary: 'the plan' }).status, 'implementing');

  // Sent back to be planned again, there is a gate ahead of it again, and the
  // ticket can be told to stop at this one.
  j.add({ type: 'plan_rejected', reason: 'wrong problem' });
  j.add({ type: 'ticket_edited', requiresApproval: true });
  assert.equal(runStage(j, 'plan', { summary: 'another plan' }).status, 'plan_gate');
});
