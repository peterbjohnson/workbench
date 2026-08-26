import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrchestrator,
  reconcile,
  type RunResult,
  type StageRunner,
  type Verdict,
} from './loop.ts';
import { openStore, type Store } from '../store/store.ts';
import type { CheckRun, Refreshed, Stage } from '../domain/events.ts';
import type { Credentials } from '../run/credentials.ts';
import { DEFAULT_POLICY } from '../domain/rules.ts';

type StageOutcome = RunResult | ((attempt: number) => RunResult);

type Harness = {
  store: Store;
  orch: ReturnType<typeof createOrchestrator>;
  /** Every stage run that happened, in order. */
  ran: Stage[];
  prsOpened: string[];
  /** Every branch-bringing-in that was asked for, in order. */
  refreshed: { id: string; alsoMerge: readonly string[] }[];
  /** Tickets whose worktree was cleaned up. */
  tidied: string[];
  /** What the loop told whoever is watching. */
  announced: string[];
  close: () => Promise<void>;
};

const ok = (summary: string): RunResult => ({ outcome: 'completed', summary });

/**
 * A whole orchestrator with the outside world faked: no agents, no git, no GitHub.
 * Everything else is the real thing.
 *
 * The only way a test builds an orchestrator, so a field added to `Deps` is filled
 * in one place. Say what the test is about — `stages` for what an agent returns, or
 * `runStage` when the test is about the run itself — and leave the rest alone.
 */
function harness(
  opts: {
    stages?: Partial<Record<Stage, StageOutcome>>;
    runStage?: StageRunner;
    /** The manager's answer. A function when it differs by ticket. */
    verdict?: Verdict | ((ticketId: string) => Verdict);
    openPr?: () => Promise<string>;
    credentials?: () => Credentials;
    /** What the standing checks say. None configured is the default. */
    checks?: CheckRun[] | (() => CheckRun[]);
    /** What bringing the base in does. An up-to-date branch is the default. */
    refresh?: (ticketId: string) => Refreshed;
  } = {},
): Harness {
  const store = openStore(':memory:');
  // A base is reported only by the call that actually cuts the branch, as the real
  // one does — otherwise every stage re-announces a branch that already exists.
  const branched = new Set<string>();
  const ran: Stage[] = [];
  const prsOpened: string[] = [];
  const refreshed: { id: string; alsoMerge: readonly string[] }[] = [];
  const tidied: string[] = [];
  const announced: string[] = [];
  const attempts = new Map<Stage, number>();

  const orch = createOrchestrator({
    store,
    workspace: {
      prepare: async (id) => {
        const first = !branched.has(id);
        branched.add(id);
        return {
          path: `/tmp/wb/${id}`,
          scratch: `/tmp/wb/${id}.scratch`,
          base: first ? 'abc1234' : null,
        };
      },
      refresh: async (id, alsoMerge = []) => {
        refreshed.push({ id, alsoMerge });
        return opts.refresh?.(id) ?? { kind: 'up-to-date' };
      },
      commit: async () => 'c0ffee1',
      discard: async (id) => {
        tidied.push(id);
      },
    },
    host: {
      openPr: async (t) => {
        const url = opts.openPr ? await opts.openPr() : `https://example/pr/${t.id}`;
        prsOpened.push(url);
        return url;
      },
      verdict: async (t) => {
        const configured = opts.verdict ?? { kind: 'pending' };
        return typeof configured === 'function' ? configured(t.id) : configured;
      },
    },
    runStage: async (args) => {
      ran.push(args.stage);
      if (opts.runStage) return opts.runStage(args);
      const attempt = (attempts.get(args.stage) ?? 0) + 1;
      attempts.set(args.stage, attempt);
      const configured = opts.stages?.[args.stage];
      if (configured === undefined) return ok(`${args.stage} done`);
      return typeof configured === 'function' ? configured(attempt) : configured;
    },
    checks: async () => (typeof opts.checks === 'function' ? opts.checks() : (opts.checks ?? [])),
    credentials: async () => opts.credentials?.() ?? { ok: true, how: 'a test' },
    announce: (message) => announced.push(message),
  });

  return {
    store,
    orch,
    ran,
    prsOpened,
    refreshed,
    tidied,
    announced,
    close: async () => {
      await orch.stop();
      store.close();
    },
  };
}

/** A ticket the manager has committed to. A backlogged one would never start. */
function create(store: Store, id = 't1'): void {
  store.append(id, { type: 'ticket_created', title: `ticket ${id}`, body: 'do it' });
  store.append(id, { type: 'queued' });
}

/**
 * A ticket whose work is already offered and waiting on the manager. Written
 * rather than run, so it is standing before anything else starts: what happens to
 * a pull request while another one merges cannot be tested against a race to
 * reach one.
 */
function standing(store: Store, id: string): void {
  create(store, id);
  store.append(id, { type: 'pr_opened', url: `https://example/pr/${id}` });
}

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

/** Lets the loop settle until `want` is true, rather than guessing how many turns it takes. */
async function waitFor(want: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (want()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

/** A ticket committed to, told what it waits for, and only then queued. */
function waiting(store: Store, id: string, tickets: string[]): void {
  store.append(id, { type: 'ticket_created', title: `ticket ${id}`, body: 'do it' });
  store.append(id, { type: 'waits_for', tickets });
  store.append(id, { type: 'queued' });
}

test('a ticket let go by a pull request is branched onto that work, not without it', async () => {
  const h = harness({ refresh: () => ({ kind: 'merged', base: 'abc1234', commit: 'merge01' }) });
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

test('dependencies that will not sit in one tree stop the ticket before it starts', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'abc1234',
      paths: ['fea/run_characteristic.py'],
      with: 'wb/t3',
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

test('a ticket left running by a crash is picked up rather than wedged', async () => {
  const store = openStore(':memory:');
  try {
    create(store);
    store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r1' });
    assert.equal(store.ticket('t1').running, true, 'nothing will ever finish this run');

    assert.deepEqual(reconcile(store), ['t1']);

    const ticket = store.ticket('t1');
    assert.equal(ticket.running, false, 'it no longer holds a slot for ever');
    assert.equal(ticket.status, 'blocked', 'and it shows up as needing the manager');
    assert.deepEqual(reconcile(store), [], 'a second start has nothing left to pick up');
  } finally {
    store.close();
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

test('a merge brings every standing pull request up to the base it moved to', async () => {
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01' }),
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

test('a pull request the manager has already answered is left alone', async () => {
  const h = harness({
    verdict: (id) =>
      id === 't1' ? { kind: 'accepted' } : { kind: 'rejected', reason: 'not like that' },
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01' }),
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

test('work that conflicts with the base it must land on is not offered', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/domain/rules.ts'],
      with: 'newbase',
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

test('work the new base breaks is not offered either', async () => {
  let asked = 0;
  const h = harness({
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01' }),
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
