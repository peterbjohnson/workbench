import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from './loop.ts';
import { create, during, harness, ok, waitFor, type Harness } from './harness.ts';
import { openStore } from '../store/store.ts';
import type { Stage } from '../domain/events.ts';
import { DEFAULT_POLICY } from '../domain/rules.ts';

test('the loop drives a ticket to the plan gate and then waits', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'it plans, and does not run ahead of the gate');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.store.ticket('t1').plan, 'plan done');
  } finally {
    await h.close();
  }
});

test('approving the plan carries the ticket through to a pull request', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();

    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify']);
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1']);
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('a review that does not approve sends the ticket round again', async () => {
  const h = harness({
    stages: {
      review: (attempt) =>
        attempt === 1
          ? { outcome: 'completed', summary: 'found a bug', rejected: 'retries are unbounded' }
          : ok('looks right now'),
    },
    verdict: { kind: 'accepted' },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // Rejected at review, so it re-plans and stops at the gate a second time.
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'plan']);
    const t = h.store.ticket('t1');
    assert.equal(t.status, 'plan_gate');
    assert.equal(t.rejection, 'retries are unbounded', 'the reason reaches the next plan');

    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran.slice(4), ['implement', 'review', 'verify']);
    assert.equal(h.store.ticket('t1').status, 'done');
  } finally {
    await h.close();
  }
});

test('a question parks the ticket, and the answer resumes that same stage', async () => {
  const h = harness({
    stages: {
      implement: (attempt) =>
        attempt === 1
          ? {
              outcome: 'blocked',
              summary: 'need a decision',
              question: { question: 'which config is live?', reasoning: 'two disagree' },
            }
          : ok('implemented'),
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const blocked = h.store.ticket('t1');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.question?.question, 'which config is live?');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'nothing runs while it waits');

    h.store.append('t1', { type: 'question_answered', answer: 'the one in etc/' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'implement', 'review', 'verify']);
  } finally {
    await h.close();
  }
});

test('answering a question carries on the conversation rather than paying for it twice', async () => {
  // t4 re-planned from scratch after an interruption: $0.16 for a plan that already
  // existed. The stage was re-run, not continued.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume, ticket }) => {
      resumedWith.push(resume);
      return resume === undefined && resumedWith.length === 1
        ? {
            outcome: 'blocked',
            summary: 'waiting on the manager',
            question: { question: 'which config is live?', reasoning: 'two disagree' },
            sessionId: 'sess-abc',
          }
        : ok(`planned, knowing: ${ticket.answer}`);
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    assert.deepEqual(resumedWith, [undefined], 'the first run has nothing to carry on from');
    assert.equal(h.store.ticket('t1').session, 'sess-abc');

    h.store.append('t1', { type: 'question_answered', answer: 'the one in etc/' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined, 'sess-abc'], 'the second picks it back up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.store.ticket('t1').session, null, 'and it is spent once used');
  } finally {
    await h.close();
  }
});

test('a stage with no conversation to resume simply starts again', async () => {
  // Nothing here may depend on a session existing: it lives outside the workbench,
  // on one machine, and a ticket must still move when it is gone.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return resumedWith.length === 1
        ? {
            outcome: 'blocked',
            summary: 'waiting',
            question: { question: 'which?', reasoning: 'unclear' },
            // No sessionId: the runner could not tell us one.
          }
        : ok('planned from the top');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    assert.equal(h.store.ticket('t1').session, null);

    h.store.append('t1', { type: 'question_answered', answer: 'this one' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined, undefined], 'asked to start afresh');
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'and it still got there');
  } finally {
    await h.close();
  }
});

test('a failing standing check sends the ticket back without asking an agent anything', async () => {
  // The whole point. Verify was 42% of t4's cost, much of it running commands and
  // reading their output. Now the run that discovers a broken test costs nothing.
  const h = harness({
    checks: [
      { command: 'yarn test', ok: false, output: '3 tests failed\n  at retry.ts:14' },
      { command: 'yarn typecheck', ok: true, output: '' },
    ],
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.ok(!h.ran.includes('verify'), 'no agent was asked: the checks had answered');
    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'review', 'plan'],
      'and it went straight back round to planning',
    );

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'plan_gate', 're-planned and stopped at the gate');
    assert.match(t.rejection ?? '', /yarn test/, 'the next plan is told which check');
    assert.match(t.rejection ?? '', /3 tests failed[\s\S]*retry\.ts:14/, 'and what it said');
  } finally {
    await h.close();
  }
});

test('what the checks said is on the record, not just in an agent summary', async () => {
  // Whether the tests passed is the most important fact about a ticket. It should be
  // observed and written down, not narrated by something with an opinion.
  const h = harness({ checks: [{ command: 'yarn test', ok: true, output: '131 passing' }] });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ran = h.store.eventsFor('t1').filter((e) => e.type === 'checks_run');
    assert.equal(ran.length, 1, 'once, at the start of verify');
    assert.deepEqual(ran[0]?.type === 'checks_run' ? ran[0].results : [], [
      { command: 'yarn test', ok: true, output: '131 passing' },
    ]);
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'and it carried on');
  } finally {
    await h.close();
  }
});

test('the passing checks are handed to verify so it does not run them again', async () => {
  const seen: unknown[] = [];
  const h = harness({
    checks: [{ command: 'yarn test', ok: true, output: '131 passing' }],
    runStage: async ({ stage, checks }) => {
      if (stage === 'verify') seen.push(checks);
      return ok(`${stage} done`);
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(seen, [[{ command: 'yarn test', ok: true, output: '131 passing' }]]);
  } finally {
    await h.close();
  }
});

test('with no checks configured nothing is run and nothing is recorded', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.eventsFor('t1').filter((e) => e.type === 'checks_run').length, 0);
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify'], 'verify still runs');
  } finally {
    await h.close();
  }
});

test('a stage that throws parks the ticket rather than looping it back to plan', async () => {
  const h = harness({
    stages: {
      implement: () => {
        throw new Error('the model service is down');
      },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked');
    assert.equal(t.rejection, null, 'a crash is not a rejection');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'it does not retry itself');

    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished')
      .at(-1);
    assert.equal(finished?.type === 'stage_finished' && finished.outcome, 'failed');
    assert.match(
      finished?.type === 'stage_finished' ? finished.summary : '',
      /model service is down/,
    );
  } finally {
    await h.close();
  }
});

test('no more than the work-in-progress limit run at the same time', async () => {
  const release: (() => void)[] = [];
  let concurrent = 0;
  let peak = 0;

  const h = harness({
    runStage: async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise<void>((resolve) => release.push(resolve));
      concurrent--;
      return ok('done');
    },
  });
  const queued = () => h.store.tickets().filter((t) => t.status === 'queued').length;

  try {
    for (const id of ['t1', 't2', 't3', 't4']) create(h.store, id);

    await h.orch.tick();
    await waitFor(() => concurrent === 2, 'two runs in flight');
    assert.equal(queued(), 2, 'two wait');

    // Finish one. Its slot should be taken by a ticket that was waiting.
    release.shift()?.();
    await waitFor(() => queued() === 1, 'the freed slot to be refilled');
    assert.equal(concurrent, 2, 'the loop refills the slot rather than leaving it idle');

    await drain();
    assert.equal(peak, 2, 'never more than two at once, across the whole run');
    assert.equal(queued(), 0);
  } finally {
    await drain(); // never leave a run un-released: close() waits for them
    await h.close();
  }

  /** Lets every started run finish, including ones that start while draining. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 100 && (release.length > 0 || concurrent > 0); i++) {
      release.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});

test('a ticket held behind another does not start, and starts when it is let go', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });

    await h.orch.idle();
    assert.equal(h.ran.length, 1, 'only the one it is waiting on was planned');
    assert.equal(h.store.ticket('t2').status, 'queued');

    // Its work is offered: nothing more will be committed on it, which is all the
    // ticket behind it was ever waiting for.
    h.store.append('t1', { type: 'pr_opened', url: 'http://pr/1' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
  } finally {
    await h.close();
  }
});

test('sending a ticket back holds what waits on it again', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });

    // t1 offers its work, so t2 is free to start.
    h.store.append('t1', { type: 'pr_opened', url: 'http://pr/1' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');

    // Now t1 is sent back, and gets stuck part-way through the rework. It keeps
    // its pull request the whole time.
    h.store.append('t1', { type: 'changes_requested', changes: 'the units are wrong' });
    h.store.append('t1', { type: 'blocked', reason: 'asked you something' });

    // Written, told what it waits for, and only then committed to — the order the
    // API writes them in, and the reason a new ticket cannot start before its
    // condition is on it.
    h.store.append('t3', { type: 'ticket_created', title: 'ticket t3', body: 'do it' });
    h.store.append('t3', { type: 'waits_for', tickets: ['t1'] });
    h.store.append('t3', { type: 'queued' });

    await h.orch.idle();
    // Waiting again, because t1 is committing again — reading `prUrl` for this
    // said it had let go, since a reworked ticket still has one.
    assert.equal(h.store.ticket('t3').status, 'queued', 't3 waits for the rework');
    assert.equal(h.store.ticket('t1').prUrl, 'http://pr/1', 'and t1 kept its pull request');
  } finally {
    await h.close();
  }
});

test('a ticket held behind one that was cancelled is let go, not stranded', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });
    h.store.append('t1', { type: 'cancelled', reason: 'not now' });

    // Nothing will ever pick t1 up again, so nothing may be left waiting on it:
    // a queue held up by a ticket nobody is working on is the one failure here
    // that has no way out and no way to see it.
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
  } finally {
    await h.close();
  }
});

test('a blocked ticket gives up its slot rather than holding it', async () => {
  const h = harness({
    stages: {
      plan: {
        outcome: 'blocked',
        summary: 'waiting',
        question: { question: 'which?', reasoning: 'unclear' },
      },
    },
  });
  try {
    for (const id of ['t1', 't2', 't3', 't4']) create(h.store, id);
    await h.orch.idle();

    // All four get planned two at a time: waiting on the manager occupies no slot.
    assert.equal(h.ran.length, 4);
    assert.equal(h.store.tickets().filter((t) => t.status === 'blocked').length, 4);
    assert.equal(h.store.tickets().filter((t) => t.status === 'queued').length, 0);
  } finally {
    await h.close();
  }
});

test('a ticket that keeps coming back stops for the manager, work intact', async () => {
  // Review never approves, so the ticket loops: plan, implement, review, plan...
  const h = harness({
    stages: { review: { outcome: 'completed', summary: 'no', rejected: 'no' } },
  });
  try {
    create(h.store);

    // The gate stops the ticket every time round, so this needs a manager who keeps
    // approving. That is the case the cap is for: the loop cannot run away by itself.
    for (let i = 0; i < 10; i++) {
      await h.orch.idle();
      if (h.store.ticket('t1').status !== 'plan_gate') break;
      h.store.append('t1', { type: 'plan_approved' });
    }
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    // Blocked, not gave_up: the work stands and the manager decides what to do
    // with it. Every real ticket the workbench has run died at this point.
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /ship what is there/);
    assert.equal(ticket.cycles, DEFAULT_POLICY.maxCycles);
    assert.equal(
      h.ran.filter((s) => s === 'plan').length,
      DEFAULT_POLICY.maxCycles,
      'it planned the allowed number of times and no more',
    );
  } finally {
    await h.close();
  }
});

test('what a failed run spent is recorded, and counts against the ticket', async () => {
  // A failure is often the expensive ending — a budget ceiling, a session limit —
  // so a failure recorded as costing nothing under-counts exactly the runs that
  // cost the most, and the ticket's total is short by the largest amounts.
  const h = harness({
    stages: {
      implement: { outcome: 'failed', summary: 'the run stopped', costUsd: 3 },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished')
      .at(-1);
    assert.equal(finished?.type === 'stage_finished' && finished.outcome, 'failed');
    assert.equal(finished?.type === 'stage_finished' ? finished.costUsd : undefined, 3);
    assert.equal(h.store.ticket('t1').costUsd, 3, 'and it is what the ticket has spent');
  } finally {
    await h.close();
  }
});

test('the loop stops a ticket that has spent its budget', async () => {
  const h = harness({
    stages: {
      plan: {
        outcome: 'completed',
        summary: 'a costly plan',
        costUsd: DEFAULT_POLICY.maxTicketUsd,
      },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'implement never started');
    assert.equal(h.store.ticket('t1').status, 'gave_up');
  } finally {
    await h.close();
  }
});

test('cancelling stops a stage that is already running', async () => {
  let sawAbort = false;
  let release: (() => void) | undefined;

  const h = harness({
    runStage: async ({ signal }) => {
      // A real stage is inside the model service here, deaf to everything but this.
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      return { outcome: 'failed', summary: 'the manager stopped this run' };
    },
  });

  try {
    create(h.store);
    void h.orch.tick();
    await waitFor(() => release !== undefined, 'the stage to start');

    h.store.append('t1', { type: 'cancelled', reason: 'changed my mind' });
    await waitFor(() => sawAbort, 'the run to be told to stop');
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'cancelled', 'and the late failure does not un-cancel it');
    assert.equal(ticket.running, false, 'so the slot is free again');
  } finally {
    release?.();
    await h.close();
  }
});

test('a stopped board starts nothing, and starting again picks the ticket up', async () => {
  const h = harness();
  try {
    h.store.setStopped(true);
    create(h.store);
    await h.orch.idle();

    assert.deepEqual(h.ran, [], 'no stage was bought');
    assert.equal(h.store.ticket('t1').status, 'queued', 'it is still waiting its turn');

    h.store.setStopped(false);
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'and it goes the moment the board does');
  } finally {
    await h.close();
  }
});

test('interrupting a running stage parks it to be carried on, not to be paid for again', async () => {
  let sawAbort = false;
  let release: (() => void) | undefined;

  const h = harness({
    runStage: async ({ signal, emit, runId }) => {
      // Named the moment the model service names it, as a real run does — this is
      // what an interrupted stage has left to carry on from.
      emit({ type: 'session_started', runId, sessionId: 'sess-abc' });
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      // What a runner really answers an aborted signal with. Left alone it would be
      // recorded as a stage that broke, and a broken stage is bought again.
      return { outcome: 'failed', summary: 'the manager stopped this run' };
    },
  });

  try {
    create(h.store);
    void h.orch.tick();
    await waitFor(() => release !== undefined, 'the stage to start');

    // The second press of STOP: the board is already stopped and the manager is not
    // waiting for what is in flight.
    h.store.setStopped(true);
    assert.deepEqual(h.orch.interrupt(), ['t1'], 'it says what it stopped');
    await waitFor(() => sawAbort, 'the run to be told to stop');
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.running, false, 'the slot is free');
    assert.equal(ticket.interrupted, true, 'and the board offers to carry it on');
    assert.equal(ticket.session, 'sess-abc', 'from the conversation it kept');
  } finally {
    release?.();
    await h.close();
  }
});

test('stopping while the standing checks run abandons the stage rather than buying it', async () => {
  // A stage is under way from `stage_started`, not from the moment the agent is
  // asked. STOP pressed while the suite runs used to find nothing to abort, tell the
  // manager nothing had been abandoned, and then buy the verify run anyway.
  let interrupted: string[] | undefined;
  let h: Harness;

  h = harness({
    checks: () => {
      if (interrupted === undefined) {
        h.store.setStopped(true);
        interrupted = h.orch.interrupt();
      }
      return [{ command: 'yarn test', ok: true, output: '131 passing' }];
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(interrupted, ['t1'], 'the second press says what it abandoned');
    assert.ok(!h.ran.includes('verify'), 'and no agent was asked for after it');

    const t = h.store.ticket('t1');
    assert.equal(t.running, false, 'the slot is free');
    assert.equal(t.interrupted, true, 'and the board offers to carry the stage on');
  } finally {
    await h.close();
  }
});

test('a stage that dies before the agent leaves nothing to stop', async () => {
  // The window between `stage_started` and the agent belongs to the run, so the run
  // is stoppable through it — and a run that dies in there has to give the name back
  // as surely as one that finishes. Left behind, STOP reports abandoning a run that
  // was already over.
  const h = harness({
    checks: () => {
      throw new Error('the suite could not be run');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked', 'the ticket parks on what went wrong');
    assert.match(t.question?.question ?? '', /the suite could not be run/);
    assert.deepEqual(h.orch.interrupt(), [], 'and there is nothing left to stop');
  } finally {
    await h.close();
  }
});

test('a run that broke while stopped does not mark the next stage stopped', async () => {
  // The other half of the leak: STOP reached this run, so its name went into
  // `broken`, and then the run died before the agent. Whatever runs next under that
  // id must not find itself already stopped and be recorded `interrupted` before it
  // has begun — a stage nobody stopped, reported as one that was.
  let firstRefresh = true;
  let h: Harness;

  h = harness({
    refresh: () => {
      if (!firstRefresh) return { kind: 'up-to-date' };
      firstRefresh = false;
      h.store.setStopped(true);
      h.orch.interrupt();
      throw new Error('could not bring the base in');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'blocked', 'the run that broke parked it');

    // Started again the way the manager starts one: the board goes back on, and the
    // ticket is put back into the stage it stopped in.
    h.store.setStopped(false);
    h.store.append('t1', { type: 'stage_restarted' });
    await h.orch.idle();

    assert.ok(h.ran.includes('implement'), 'the stage runs');
    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished' && e.outcome === 'interrupted');
    assert.deepEqual(finished, [], 'and nothing is recorded as stopped');
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'it carries on to the end');
  } finally {
    await h.close();
  }
});

test('a ticket left running by a crash is picked up rather than wedged', async () => {
  const store = openStore(':memory:');
  try {
    create(store);
    store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r1' });
    store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    assert.equal(store.ticket('t1').running, true, 'nothing will ever finish this run');

    assert.deepEqual(reconcile(store), ['t1']);

    const ticket = store.ticket('t1');
    assert.equal(ticket.running, false, 'it no longer holds a slot for ever');
    assert.equal(ticket.status, 'blocked', 'and it shows up as needing the manager');
    assert.equal(ticket.interrupted, true, 'as stopped rather than as broken');
    assert.equal(ticket.session, 'sess-abc', 'holding the run it can carry on from');
    assert.deepEqual(reconcile(store), [], 'a second start has nothing left to pick up');
  } finally {
    store.close();
  }
});

test('continuing an interrupted stage runs it on the conversation it had', async () => {
  // Everything an interrupted run spent used to be spent again from the top, and
  // restarting is routine now: it is how an update is picked up.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return ok('planned');
    },
  });

  try {
    create(h.store);
    h.store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    h.store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    assert.deepEqual(reconcile(h.store), ['t1']);

    h.store.append('t1', { type: 'stage_continued' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, ['sess-abc'], 'it picked the run back up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'and the stage finished');
  } finally {
    await h.close();
  }
});

test('restarting an interrupted stage runs it from the top instead', async () => {
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return ok('planned');
    },
  });

  try {
    create(h.store);
    h.store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    h.store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    reconcile(h.store);

    h.store.append('t1', { type: 'stage_restarted' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined], 'nothing carried over');
  } finally {
    await h.close();
  }
});

test('being logged out pauses the board rather than burning it', async () => {
  let loggedIn = false;
  const h = harness({
    credentials: () =>
      loggedIn
        ? { ok: true, how: 'a test' }
        : { ok: false, why: 'the Claude CLI is not logged in', fix: 'run: claude setup-token' },
  });

  try {
    for (const id of ['t1', 't2']) create(h.store, id);
    await h.orch.idle();

    // The point of the whole design: nothing was attempted, so nothing was spent.
    assert.deepEqual(h.ran, [], 'no stage ran');
    for (const id of ['t1', 't2']) {
      const t = h.store.ticket(id);
      assert.equal(t.status, 'queued', 'still waiting, not blocked and not failed');
      assert.equal(t.cycles, 0, 'no cycle consumed');
      assert.equal(t.costUsd, 0, 'nothing spent');
    }
    assert.equal(
      h.store.eventsFor('t1').length,
      2,
      'nothing was written down but the ticket and the decision to do it',
    );
    assert.equal(h.announced.length, 1, 'said once, not once per ticket per tick');
    assert.match(h.announced[0] ?? '', /paused[\s\S]*setup-token/);

    // Logging back in needs no restart and nothing cleaned up.
    loggedIn = true;
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'plan'], 'both tickets picked themselves up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.announced.length, 2);
    assert.match(h.announced[1] ?? '', /carrying on/);
  } finally {
    await h.close();
  }
});

test('losing credentials mid-flight stops the next stage, not the current ticket', async () => {
  let loggedIn = true;
  const h = harness({
    credentials: () =>
      loggedIn ? { ok: true, how: 'a test' } : { ok: false, why: 'expired', fix: 'log in' },
    stages: {
      plan: () => {
        // The token dies while the plan is running.
        loggedIn = false;
        return { outcome: 'completed', summary: 'the plan', costUsd: 0.2 };
      },
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'implement never started');
    const t = h.store.ticket('t1');
    assert.equal(t.status, 'implementing', 'it is waiting to implement, not broken');
    assert.equal(t.costUsd, 0.2, 'and it kept the record of what it had already spent');
  } finally {
    await h.close();
  }
});

test('a refused credential stops the board, not just the ticket that found out', async () => {
  // Presence is not acceptance: the check said "Ready" and the API said 401. Without
  // this, the workbench works through the queue spending a stage on each ticket to
  // learn the same thing.
  const h = harness({
    stages: {
      plan: {
        outcome: 'failed',
        summary:
          'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      },
    },
  });

  try {
    for (const id of ['t1', 't2', 't3']) create(h.store, id);
    await h.orch.idle();

    // Everything already in flight when the answer arrives pays for it, so the
    // blast radius is the work-in-progress limit rather than the whole queue.
    assert.equal(h.ran.length, DEFAULT_POLICY.wipLimit, 'only what was already running');
    assert.equal(h.store.ticket('t3').status, 'queued', 'the queue behind it was spared');
    const said = h.announced.at(-1) ?? '';
    assert.match(
      said,
      /paused[\s\S]*401[\s\S]*CLAUDE_CODE_OAUTH_TOKEN/,
      'says what and how to fix',
    );
    assert.doesNotMatch(
      said,
      /start on their own/,
      'and does not promise a resume that cannot happen: a refused credential has to be replaced',
    );

    // Sticky: the local check still finds a credential, because there is one. Only a
    // real call knows it is refused, so re-checking must not undo the stop.
    const ranBefore = h.ran.length;
    await h.orch.idle();
    assert.equal(h.ran.length, ranBefore, 'and it stays stopped');
  } finally {
    await h.close();
  }
});

test('a conflict at the start of a stage is handed to the stage, not to the manager', async () => {
  const handed: { stage: Stage; paths: string[] }[] = [];
  const h = harness({
    refresh: (id) =>
      id === 't1' && handed.length === 0
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
    runStage: async ({ stage, conflict }) => {
      if (conflict) handed.push({ stage, paths: conflict.paths });
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(handed, [{ stage: 'implement', paths: ['src/rules.ts'] }]);
    const conflicted = during(h.store, 't1', 'implement').filter((e) => e.type === 'conflicted');
    assert.equal(conflicted.length, 1, 'recorded on the ticket, with what clashed');
    assert.deepEqual(conflicted[0]?.type === 'conflicted' ? conflicted[0].paths : [], [
      'src/rules.ts',
    ]);

    // The whole point: the stage runs, and resolving it is part of the run rather
    // than something a person is asked about a day later.
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify']);
    assert.ok(
      h.committed.some((c) => c.startsWith('t1: implement')),
      'and its work is committed',
    );
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('the checks a merge kept from running at the start of verify are run at the end', async () => {
  // Before the run they would be asked of a tree full of conflict markers, fail for
  // that alone, and send the ticket back to planning without the agent ever seeing
  // the merge. After it, they are the only thing that will ask: `open_pr` refreshes
  // a branch that is by then up to date and runs nothing.
  let refreshes = 0;
  const order: string[] = [];
  const h = harness({
    refresh: () =>
      ++refreshes === 2
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
    checks: () => {
      order.push('checks');
      return [{ command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' }];
    },
    runStage: async ({ stage }) => {
      order.push(stage);
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      order.slice(0, 5),
      ['plan', 'implement', 'review', 'verify', 'checks'],
      'asked of the tree the stage resolved, not the one it was given',
    );
    assert.equal(
      during(h.store, 't1', 'verify').filter((e) => e.type === 'checks_run').length,
      1,
      'and what they said is on the ticket',
    );

    assert.match(
      h.store.ticket('t1').rejection ?? '',
      /1 failing/,
      'a suite the merge broke sends the work back, with the failure itself',
    );
    assert.deepEqual(
      order.slice(5),
      ['plan'],
      'to a new plan rather than to a pull request nobody ran the suite against',
    );
    assert.deepEqual(h.prsOpened, []);
  } finally {
    await h.close();
  }
});

test('the base a resolved merge brought in is recorded when the stage commits it', async () => {
  // Until the commit there is nothing on the branch to move the base to, and after
  // it there had better be: the diff every later stage reads is taken from the
  // ticket's base, so an old one shows the merged-in work as this ticket's own.
  let refreshes = 0;
  const h = harness({
    refresh: () =>
      refreshes++ === 0
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const refreshed = during(h.store, 't1', 'implement').filter((e) => e.type === 'refreshed');
    assert.equal(refreshed.length, 1, 'the merge is on the branch, so the base has moved');
    assert.equal(h.store.ticket('t1').base, 'newbase');

    // The merge commit is named twice — by the refresh and by the stage that made
    // it — and is one commit.
    const merge = refreshed[0]?.type === 'refreshed' ? refreshed[0].commit : '';
    assert.deepEqual(
      h.store.ticket('t1').commits.filter((c) => c === merge),
      [merge],
    );
  } finally {
    await h.close();
  }
});

test('a stage that leaves the merge unfinished is blocked, and commits nothing', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: true,
    }),
    unresolved: (paths) => [...paths],
    stages: { implement: ok('rewrote the retry loop') },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'and the ticket goes no further');

    assert.deepEqual(
      h.committed.filter((c) => c.includes('implement')),
      [],
      'committing would put the markers on the branch as though they were work',
    );
    const finished = h.store.eventsFor('t1').findLast((e) => e.type === 'stage_finished');
    assert.equal(finished?.type === 'stage_finished' ? finished.outcome : '', 'blocked');
    const summary = finished?.type === 'stage_finished' ? finished.summary : '';
    assert.match(summary, /src\/rules\.ts/, 'saying what is unfinished');
    assert.match(summary, /rewrote the retry loop/, 'and keeping what the run said it did');
  } finally {
    await h.close();
  }
});
