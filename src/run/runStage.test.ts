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
};

/** A model service that never leaves the machine. One script per call, in order. */
function service(scripts: Script[]): {
  query: NonNullable<StageRunnerDeps['query']>;
  /** The options every call was made with, so a test can see what was resumed. */
  calls: Options[];
} {
  const calls: Options[] = [];
  const remaining = [...scripts];

  const query: NonNullable<StageRunnerDeps['query']> = ({ options }) => {
    const script = remaining.shift() ?? {};
    calls.push(options ?? {});

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
      if (script.throws !== undefined) throw new Error(script.throws);
    }

    const session = messages() as ReturnType<NonNullable<StageRunnerDeps['query']>>;
    session.interrupt = async () => undefined;
    return session;
  };

  return { query, calls };
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
  opts: { resume?: string; ticket?: Ticket } = {},
): Promise<{ result: RunResult; calls: Options[]; said: EventBody[] }> {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-run-'));
  const model = service(scripts);
  const said: EventBody[] = [];

  try {
    const result = await createStageRunner({
      agents: () => AGENTS,
      protectedPaths: [],
      about: '',
      pluginRoot: worktree,
      skills: () => [],
      diff: async () => '',
      continued: () => '',
      query: model.query,
    })({
      ticket: opts.ticket ?? aTicket(),
      stage: 'implement',
      runId: 'r1',
      worktree,
      scratch: path.join(worktree, '.scratch'),
      resume: opts.resume,
      emit: (body) => said.push(body),
      signal: new AbortController().signal,
    });
    return { result, calls: model.calls, said };
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
