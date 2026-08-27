import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';

import { createWarmPool } from './warmPool.ts';

type Run = NonNullable<NonNullable<Parameters<typeof createWarmPool>[0]>['run']>;

/** One subprocess that never happened: what it was asked, and whether it was killed. */
type Spawned = { prompts: string[]; signal: AbortSignal | undefined };

/**
 * What a session does when it is asked something: the text it answers with, or
 * nothing at all — a session can end saying no more than a dead one does.
 */
type Reply = (question: string) => Promise<string | undefined>;

const answers: Reply = async (question) => `answer to ${question}`;

/**
 * Subprocesses that never leave the machine, and that behave the way the real ones
 * were measured to: nothing at all comes out of a session until it has been given
 * something to answer, however long it has been up.
 */
function service(reply: Reply = answers): { run: Run; spawned: Spawned[] } {
  const spawned: Spawned[] = [];

  const run: Run = ({ prompt, options }) => {
    const one: Spawned = { prompts: [], signal: options?.abortController?.signal };
    spawned.push(one);

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      for await (const said of prompt as AsyncIterable<SDKUserMessage>) {
        const question = String(said.message.content);
        one.prompts.push(question);
        const result = await reply(question);
        if (result === undefined) return;
        yield {
          type: 'result',
          subtype: 'success',
          result,
          total_cost_usd: 0,
          session_id: `session-${spawned.length}`,
        } as unknown as SDKMessage;
      }
    }

    return messages() as ReturnType<typeof query>;
  };

  return { run, spawned };
}

/** A session that fails the first time it is asked, and answers after that. */
function failsOnce(how: Reply): Reply {
  let first = true;
  return async (question) => {
    if (!first) return answers(question);
    first = false;
    return how(question);
  };
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

test('a standby that died while it waited does not take the question with it', async () => {
  // A subprocess can be gone by the time it is asked — a boot that got nowhere, a
  // credential refused, a machine that slept. Slow rather than broken, as with an
  // empty pool: this is a question that would have been answered before there was one.
  const model = service(
    failsOnce(async () => {
      throw new Error('the session ended');
    }),
  );
  const pool = createWarmPool({ run: model.run, standbys: 1 });

  pool.warm();
  assert.equal(await pool.ask('what is this called'), 'answer to what is this called');
  assert.deepEqual(model.spawned[0]?.prompts, ['what is this called'], 'the dead one was asked');
  assert.deepEqual(model.spawned[1]?.prompts, ['what is this called'], 'and a new one answered');

  await pool.close();
});

test('a session that ends having said nothing is a death like any other', async () => {
  const model = service(failsOnce(async () => undefined));
  const pool = createWarmPool({ run: model.run, standbys: 1 });

  pool.warm();
  assert.equal(await pool.ask('what is this called'), 'answer to what is this called');

  await pool.close();
});

test('shutting down with an ask in flight starts nothing back up', async () => {
  // Ctrl-C during a name check: the ask settles into a pool that has already closed.
  // Topping up there is two fresh subprocesses and a five-minute timer, which is
  // `wb serve` printing that it has drained and then not going anywhere.
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const model = service(async (question) => {
    await held;
    return `answer to ${question}`;
  });
  const pool = createWarmPool({ run: model.run, standbys: 2, idleMs: 50 });

  pool.warm();
  const asking = pool.ask('what is this called');
  await pool.close();
  answer();
  await asking.catch(() => {});

  assert.equal(model.spawned.length, 2, 'a closed pool starts nothing, however the ask ends');
  assert.ok(
    model.spawned.every((one) => one.signal?.aborted),
    'including the one in the middle of the ask, which nothing else can reach',
  );
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
