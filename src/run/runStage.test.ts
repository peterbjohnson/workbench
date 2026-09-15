import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createStageRunner, type StageRunnerDeps } from './runStage.ts';
import type { AgentDef } from '../agents/load.ts';
import type { EventBody, Stage } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import type { RunResult } from '../orchestrator/loop.ts';
import { openStore } from '../store/store.ts';

/**
 * What one call to the model service does: says these, and then either stops or
 * throws. Throwing is the interesting half — it is how the SDK reports a run that
 * hit its budget ceiling or its session limit, which are the runs that cost most.
 */
type Script = {
  /** What each result message reports having cost, in the order they arrive. */
  costs?: number[];
  /** Asks the manager something first, through the hook, as a real run does. */
  asks?: boolean;
  /** The error the call ends with. Ends cleanly when absent. */
  throws?: string;
  /** What the SDK hangs on that error — a status code, a type — as a real one does. */
  throwsWith?: Record<string, unknown>;
};

/** A model service that never leaves the machine. One script per call, in order. */
function service(scripts: Script[]): {
  query: NonNullable<StageRunnerDeps['query']>;
  /** The options every call was made with, so a test can see what was resumed. */
  calls: Options[];
  /** What each call was sent, so a test can see whether the brief was rebuilt. */
  prompts: string[];
} {
  const calls: Options[] = [];
  const prompts: string[] = [];
  const remaining = [...scripts];

  const query: NonNullable<StageRunnerDeps['query']> = ({ prompt, options }) => {
    const script = remaining.shift() ?? {};
    calls.push(options ?? {});
    prompts.push(typeof prompt === 'string' ? prompt : '');

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      if (script.asks === true) {
        const hook = options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
        assert.ok(hook, 'a run is watching its tool calls');
        await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'AskUserQuestion',
            tool_input: { questions: [{ question: 'which one?', header: 'the fork' }] },
          } as unknown as HookInput,
          undefined,
          { signal: new AbortController().signal },
        );
      }
      for (const cost of script.costs ?? []) {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          total_cost_usd: cost,
          session_id: 'session-1',
        } as unknown as SDKMessage;
      }
      if (script.throws !== undefined) {
        throw Object.assign(new Error(script.throws), script.throwsWith ?? {});
      }
    }

    const session = messages() as ReturnType<NonNullable<StageRunnerDeps['query']>>;
    session.interrupt = async () => undefined;
    return session;
  };

  return { query, calls, prompts };
}

const AGENT: AgentDef = {
  stage: 'implement',
  model: 'a-model',
  effort: 'low',
  permissionMode: 'default',
  maxTurns: 4,
  maxBudgetUsd: 3,
  allowedTools: ['Read'],
  disallowedTools: [],
  scales: {},
  instructions: 'do the work',
};

const AGENTS = Object.fromEntries(
  (['plan', 'implement', 'review', 'verify'] as Stage[]).map((stage) => [
    stage,
    { ...AGENT, stage },
  ]),
) as Record<Stage, AgentDef>;

/** A ticket as the store builds one, so nothing here is a hand-made shape. */
function aTicket(over: Partial<Ticket> = {}): Ticket {
  const store = openStore(':memory:');
  store.append('t1', { type: 'ticket_created', title: 'a ticket', body: 'do it' });
  const built = store.ticket('t1');
  store.close();
  return { ...built, ...over };
}

/**
 * One stage run against a scripted service, in a worktree that is real but empty.
 * `resume` is a session id, exactly as the orchestrator passes one.
 */
async function runStage(
  scripts: Script[],
  opts: {
    resume?: string;
    ticket?: Ticket;
    stage?: Stage;
    now?: Date;
    /** What review last asked for, exactly as the orchestrator hands one over. */
    previously?: { changes: string; at: string | null };
    /** What the diff since that review comes back as. Empty means nothing was committed. */
    since?: string;
    /** What the last implement run said it did, as the orchestrator hands it over. */
    didBefore?: string;
  } = {},
): Promise<{
  result: RunResult;
  calls: Options[];
  prompts: string[];
  said: EventBody[];
  /** What each diff was measured from, in order. Undefined is the ticket's base. */
  diffs: (string | undefined)[];
}> {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-run-'));
  const model = service(scripts);
  const said: EventBody[] = [];
  const diffs: (string | undefined)[] = [];

  try {
    const result = await createStageRunner({
      agents: () => AGENTS,
      protectedPaths: [],
      about: '',
      pluginRoot: worktree,
      skills: () => [],
      diff: async (_ticket, _worktree, from) => {
        diffs.push(from);
        if (from === undefined) return '+ the whole change';
        return opts.since ?? '+ since you looked';
      },
      continued: () => '',
      query: model.query,
      now: () => opts.now ?? new Date(),
    })({
      ticket: opts.ticket ?? aTicket(),
      stage: opts.stage ?? 'implement',
      runId: 'r1',
      worktree,
      scratch: path.join(worktree, '.scratch'),
      previously: opts.previously,
      didBefore: opts.didBefore,
      resume: opts.resume,
      emit: (body) => said.push(body),
      signal: new AbortController().signal,
    });
    return { result, calls: model.calls, prompts: model.prompts, said, diffs };
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

test('a run that throws is a failure carrying what it spent', async () => {
  // The reason this matters: the SDK throws when a run hits its budget ceiling or a
  // session limit, so the endings that threw were the expensive ones, and every one
  // of them was recorded as having cost nothing.
  const { result } = await runStage([{ costs: [3], throws: 'reached its cost limit' }]);

  assert.equal(result.outcome, 'failed');
  assert.equal(result.costUsd, 3);
});

test('a run that throws before spending anything says so, rather than saying nothing', async () => {
  const { result } = await runStage([{ throws: 'the model service is down' }]);

  assert.equal(result.outcome, 'failed');
  assert.equal(result.costUsd, 0, 'zero, not absent: nothing spent is a figure too');
});

test('a run that ends normally still reports its cost', async () => {
  const { result } = await runStage([{ costs: [0.5, 0.25] }]);

  assert.equal(result.outcome, 'completed');
  assert.equal(result.costUsd, 0.75, 'every turn of the run, added up');
});

test('asking the manager survives the throw that interrupting causes', async () => {
  // Interrupting a run to ask makes the SDK throw. Treating that as a failure would
  // lose the question, which is the whole mechanism failing at the last inch.
  const { result } = await runStage([{ costs: [0.4], asks: true, throws: 'aborted' }]);

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.question?.question, 'which one?');
  assert.equal(result.costUsd, 0.4, 'and what it cost to get that far');
});

test('a resumed run that got nowhere starts the stage again from the top', async () => {
  const { result, calls } = await runStage(
    [{ throws: 'no conversation found with that id' }, { costs: [0.6] }],
    { resume: 'session-gone', ticket: aTicket({ answer: 'the second one' }) },
  );

  assert.equal(calls.length, 2, 'it tried again');
  assert.equal(calls[0]?.resume, 'session-gone');
  assert.equal(calls[1]?.resume, undefined, 'the second attempt is a fresh conversation');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.costUsd, 0.6);
});

test('a resumed run that spent money before throwing is not paid for twice', async () => {
  const { result, calls } = await runStage([{ costs: [1.4], throws: 'reached its cost limit' }], {
    resume: 'session-1',
    ticket: aTicket({ answer: 'carry on' }),
  });

  assert.equal(calls.length, 1, 'it did not run the stage again');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.costUsd, 1.4, 'and the money it burned is on the record');
});

test('the conversation is recorded while the run is going, not when it ends', async () => {
  // The whole of the fix: a run that is killed never gets to report anything, so a
  // session written down only at the end is one that never survives an interruption.
  const { said } = await runStage([{ costs: [0.5, 0.25] }]);

  assert.deepEqual(
    said.filter((e) => e.type === 'session_started'),
    [{ type: 'session_started', runId: 'r1', sessionId: 'session-1' }],
    'once, the moment the conversation had a name',
  );
});

test('a run picked back up after the workbench stopped is told that, and not rebriefed', async () => {
  // No answer on the ticket: nothing was asked. The agent has to be told what
  // happened, or it goes looking for what it did wrong.
  const { result, calls, prompts } = await runStage([{ costs: [0.5] }], { resume: 'sess-abc' });

  assert.equal(calls.length, 1, 'it did not start the stage again');
  assert.equal(calls[0]?.resume, 'sess-abc');
  assert.match(prompts[0] ?? '', /workbench was stopped/);
  assert.doesNotMatch(prompts[0] ?? '', /answered the question/, 'nothing was asked');
  assert.doesNotMatch(prompts[0] ?? '', /## Ticket/, 'and the brief was not built again');
  assert.equal(result.outcome, 'completed');
});

test('a picked-up run whose conversation is gone still runs the stage, from the top', async () => {
  // The one thing this must never do is lose a ticket. A session lives on one
  // machine and can simply be gone; the stage still has to happen.
  const { result, calls, prompts } = await runStage(
    [{ throws: 'no conversation found with that id' }, { costs: [0.6] }],
    { resume: 'sess-gone' },
  );

  assert.equal(calls.length, 2, 'it tried again');
  assert.equal(calls[1]?.resume, undefined, 'as a fresh conversation');
  assert.match(prompts[1] ?? '', /## Ticket/, 'briefed in full, because it knows nothing');
  assert.equal(result.outcome, 'completed');
});

test('a later review is briefed with the change made since it last looked', async () => {
  // Measured from where the branch stood at that review rather than from the base,
  // so the second round reads what was done about its list and not the whole change
  // over again.
  const { prompts, diffs } = await runStage([{ costs: [0.5] }], {
    stage: 'review',
    previously: { changes: '- retry.ts:14 the backoff is unbounded', at: 'c0ffee2' },
  });

  assert.deepEqual(diffs, [undefined, 'c0ffee2'], 'the whole change, and the part since');
  assert.match(prompts[0] ?? '', /## The round before this one/);
  assert.match(prompts[0] ?? '', /\+ since you looked/);
});

test('a review with no commit standing under it is not shown the same diff twice', async () => {
  const { prompts, diffs } = await runStage([{ costs: [0.5] }], {
    stage: 'review',
    previously: { changes: '- retry.ts:14 the backoff is unbounded', at: null },
  });

  assert.deepEqual(diffs, [undefined], 'nothing had been committed, so there is nothing since');
  assert.match(prompts[0] ?? '', /Nothing had been committed when you looked/);
});

test('a later review with nothing committed since is told that, not told nothing ever was', async () => {
  // The implement run between two reviews can end without committing anything, and
  // then the diff since comes back empty. That is a different fact from there having
  // been no commit at all when review looked, and a more useful one: it says nothing
  // has been done about the list.
  const { prompts, diffs } = await runStage([{ costs: [0.5] }], {
    stage: 'review',
    previously: { changes: '- retry.ts:14 the backoff is unbounded', at: 'c0ffee2' },
    since: '',
  });

  assert.deepEqual(diffs, [undefined, 'c0ffee2'], 'there was a commit to measure from');
  assert.match(prompts[0] ?? '', /Nothing has been committed since you looked/);
  assert.doesNotMatch(prompts[0] ?? '', /Nothing had been committed when you looked/);
});

test('an implement run with commits behind it is briefed with the change so far', async () => {
  // A round sent back for changes used to be given the plan and the objections and
  // nothing about the change they are about, and read 4–8 files working out its own work.
  const { prompts, diffs } = await runStage([{ costs: [0.5] }], {
    ticket: aTicket({ commits: ['abc1234'] }),
    didBefore: 'capped the backoff in retry.ts',
  });

  assert.deepEqual(diffs, [undefined], 'from the base, down the same path review measures');
  assert.match(prompts[0] ?? '', /\+ the whole change/);
  assert.match(prompts[0] ?? '', /capped the backoff in retry\.ts/);
});

test('a first implement run asks for no diff, because there is nothing yet to diff', async () => {
  const { prompts, diffs } = await runStage([{ costs: [0.5] }]);

  assert.deepEqual(diffs, [], 'nothing committed, so nothing was asked of git');
  assert.doesNotMatch(prompts[0] ?? '', /## The change so far/);
});

/** What the service throws when the account has spent its window. */
const LIMIT = "You've hit your session limit · resets 10:30pm (Europe/London)";
/** 20:00 UTC is 21:00 in London in September, so the reset is ninety minutes off. */
const BEFORE_THE_RESET = new Date('2026-09-14T20:00:00Z');

test('a run that hits the session limit is parked rather than failed', async () => {
  const { result } = await runStage([{ costs: [0.8], throws: LIMIT }], { now: BEFORE_THE_RESET });

  assert.equal(
    result.outcome,
    'interrupted',
    'the service said come back later, not that this broke',
  );
  assert.equal(result.limitedUntil, '2026-09-14T21:30:00.000Z', 'and said when');
  assert.equal(
    result.limitedModel,
    'a-model',
    'attributed to the model this run was on, since the message names none',
  );
  assert.equal(result.sessionId, 'session-1', 'the conversation is kept, to come back to');
  assert.equal(result.costUsd, 0.8);
});

test('a session limit on a resumed run does not buy the stage a second time', async () => {
  // The whole point of not calling it a crash: a crashed resume starts the stage
  // again from the top, which is the cost this exists to avoid.
  const { result, calls } = await runStage([{ throws: LIMIT }], {
    resume: 'sess-abc',
    now: BEFORE_THE_RESET,
  });

  assert.equal(calls.length, 1, 'it did not run the stage again');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.limitedUntil, '2026-09-14T21:30:00.000Z');
});

test('a session limit that does not say when still fails', async () => {
  // Nothing to wait for. Waiting anyway would hold the whole board for ever.
  const { result } = await runStage([{ throws: "You've hit your session limit" }]);

  assert.equal(result.outcome, 'failed');
  assert.equal(result.limitedUntil, undefined);
});

test('a reworded limit is parked on what the throw carried, not on its wording', async () => {
  // The failure this guards: the service rewords the message, the text stops matching,
  // and every night's runs fail and drop their sessions without a word. The 429 is the
  // half of the throw the service does not get to reword.
  const { result } = await runStage(
    [
      {
        costs: [0.8],
        throws: 'Your usage cap is reached · resets 10:30pm (Europe/London)',
        throwsWith: { status: 429 },
      },
    ],
    { now: BEFORE_THE_RESET },
  );

  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.limitedUntil, '2026-09-14T21:30:00.000Z', 'read from the text, as ever');
  assert.equal(result.sessionId, 'session-1');
});

test('a limit that named no time is said out loud, and still fails', async () => {
  // Failing is right — there is nothing to wait for. Failing silently is not: this is
  // exactly what a reworded message looks like from in here, and it should be visible
  // the first night rather than after a week of sessions going missing.
  const { result, said } = await runStage([
    { costs: [0.8], throws: 'Your usage cap is reached', throwsWith: { status: 429 } },
  ]);

  assert.equal(result.outcome, 'failed');
  assert.equal(result.summary, 'Your usage cap is reached', 'the same summary as before');
  assert.equal(result.costUsd, 0.8, 'and the same cost');
  assert.equal(result.limitedUntil, undefined);
  assert.ok(
    said.some((e) => e.type === 'agent_said' && /no reset time/.test(e.text)),
    'the record says a limit went unread',
  );
});

test('an ordinary crash says nothing about limits', async () => {
  const { result, said } = await runStage([{ throws: 'the model service is down' }]);

  assert.equal(result.outcome, 'failed');
  assert.ok(!said.some((e) => e.type === 'agent_said' && /no reset time/.test(e.text)));
});

test('a resumed run that failed without throwing is that stage answer', async () => {
  // Only a crash means the session was not there. Anything that ran and ended has
  // answered, and re-running it would pay a second time for the same stage.
  const { result, calls } = await runStage([{ costs: [0.2], asks: true }, { costs: [0.9] }], {
    resume: 'session-1',
    ticket: aTicket({ answer: 'carry on' }),
  });

  assert.equal(calls.length, 1, 'it did not run the stage again');
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.costUsd, 0.2);
});
