import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';

import { createWarmPool } from './warmPool.ts';

type Run = NonNullable<NonNullable<Parameters<typeof createWarmPool>[0]>['run']>;

/** One subprocess that never happened: what it was asked, and whether it was killed. */
type Spawned = { prompts: string[]; signal: AbortSignal | undefined };

/**
 * Subprocesses that never leave the machine, and that behave the way the real ones
 * were measured to: nothing at all comes out of a session until it has been given
 * something to answer, however long it has been up.
 */
function service(): { run: Run; spawned: Spawned[] } {
  const spawned: Spawned[] = [];

  const run: Run = ({ prompt, options }) => {
    const one: Spawned = { prompts: [], signal: options?.abortController?.signal };
    spawned.push(one);

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      for await (const said of prompt as AsyncIterable<SDKUserMessage>) {
        const question = String(said.message.content);
        one.prompts.push(question);
        yield {
          type: 'result',
          subtype: 'success',
          result: `answer to ${question}`,
          total_cost_usd: 0,
          session_id: `session-${spawned.length}`,
        } as unknown as SDKMessage;
      }
    }

    return messages() as ReturnType<typeof query>;
  };

  return { run, spawned };
}

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a warmed ask is answered by a subprocess that was already up', async () => {
  const model = service();
  const pool = createWarmPool({ run: model.run, standbys: 1 });

  pool.warm();
  assert.equal(model.spawned.length, 1, 'warming starts one before anything is asked');
  assert.deepEqual(model.spawned[0]?.prompts, [], 'and it is up with nothing asked of it yet');

  assert.equal(await pool.ask('what is this called'), 'answer to what is this called');
  assert.deepEqual(model.spawned[0]?.prompts, ['what is this called'], 'the standby answered it');
  assert.equal(model.spawned.length, 2, 'and one was started to replace it');

  await pool.close();
});

test('a standby answers once and is never asked again', async () => {
  // Turn one of a fresh session every time. A second question down the same process
  // would carry the first ticket's name into the answer about the second.
  const model = service();
  const pool = createWarmPool({ run: model.run, standbys: 1 });

  pool.warm();
  assert.equal(await pool.ask('first'), 'answer to first');
  assert.equal(await pool.ask('second'), 'answer to second');

  assert.deepEqual(model.spawned[0]?.prompts, ['first']);
  assert.deepEqual(model.spawned[1]?.prompts, ['second']);

  await pool.close();
});

test('a pool with nothing waiting still answers, by starting one', async () => {
  // Slow rather than broken: this is what every ask was before there was a pool.
  const model = service();
  const pool = createWarmPool({ run: model.run, standbys: 1 });

  assert.equal(await pool.ask('cold'), 'answer to cold');
  assert.deepEqual(model.spawned[0]?.prompts, ['cold']);

  await pool.close();
});

test('closing leaves nothing running', async () => {
  const model = service();
  const pool = createWarmPool({ run: model.run, standbys: 2 });

  pool.warm();
  await pool.close();

  assert.equal(model.spawned.length, 2);
  assert.ok(
    model.spawned.every((one) => one.signal?.aborted),
    'a stopped workbench holds no subprocess open',
  );
});

test('standbys nobody asks anything are let go', async () => {
  const model = service();
  const pool = createWarmPool({ run: model.run, standbys: 2, idleMs: 5 });

  pool.warm();
  await after(30);

  assert.ok(
    model.spawned.every((one) => one.signal?.aborted),
    'an abandoned form leaves no subprocess behind',
  );
  await pool.close();
});
