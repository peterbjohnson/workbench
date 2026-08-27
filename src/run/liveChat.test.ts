import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Options, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';

import { createLiveChats } from './liveChat.ts';

type Run = NonNullable<NonNullable<Parameters<typeof createLiveChats>[0]>['run']>;

/** One subprocess that never happened: what it was told, and whether it was killed. */
type Spawned = { prompts: string[]; options: Options; signal: AbortSignal | undefined };

/**
 * What a session says back to one thing it was told. `undefined` is a session that
 * ends instead of answering, which is what a dead process looks like from here.
 */
type Said = { text?: string; total?: number; throws?: string } | undefined;
type Reply = (prompt: string, nth: number) => Promise<Said>;

const answers: Reply = async (prompt) => ({ text: `answer to ${prompt}` });

/**
 * Subprocesses that never leave the machine, fed the way the real ones are: one
 * stream per process, one `result` per thing pushed down it, and the iterator left
 * where it stopped so the next turn carries on rather than starting again.
 */
function service(reply: Reply = answers): { run: Run; spawned: Spawned[] } {
  const spawned: Spawned[] = [];

  const run: Run = ({ prompt, options }) => {
    const one: Spawned = {
      prompts: [],
      options: options ?? {},
      signal: options?.abortController?.signal,
    };
    spawned.push(one);

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      for await (const pushed of prompt as AsyncIterable<SDKUserMessage>) {
        const question = String(pushed.message.content);
        one.prompts.push(question);
        const said = await reply(question, one.prompts.length);
        if (said === undefined) return;
        if (said.throws !== undefined) throw new Error(said.throws);
        yield {
          type: 'result',
          subtype: 'success',
          result: said.text ?? '',
          total_cost_usd: said.total ?? 0,
          session_id: `session-${spawned.length}`,
        } as unknown as SDKMessage;
      }
    }

    return messages() as ReturnType<typeof query>;
  };

  return { run, spawned };
}

/** Fresh options per spawn, because the abort controller in them is the kill switch. */
const options = (): Options => ({ abortController: new AbortController() }) as Options;

/** What the runner asks for: the whole brief the first time, the message after that. */
const saying = (fresh: boolean) => (fresh ? 'the whole brief' : 'just the message');

const free = () => new AbortController().signal;
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a warmed process answers the turn it was started for, and the next one too', async () => {
  const model = service();
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  assert.equal(model.spawned.length, 1, 'opening the pane starts one');
  assert.deepEqual(model.spawned[0]?.prompts, [], 'and it is up with nothing said to it yet');

  const first = await live.take('t1', saying, free());
  assert.equal(first?.text, 'answer to the whole brief', 'the first turn briefs it');

  const second = await live.take('t1', saying, free());
  assert.equal(second?.text, 'answer to just the message');

  assert.equal(model.spawned.length, 1, 'both turns went down the one process');
  assert.deepEqual(model.spawned[0]?.prompts, ['the whole brief', 'just the message']);
  assert.equal(
    model.spawned[0]?.options.resume,
    undefined,
    'it never left, so there is no session to reload',
  );

  await live.close();
});

test('a turn with nothing standing is not served', async () => {
  // Nothing is spawned here on purpose: the caller has a cold path, and it is the
  // one every turn took before there was a living process at all.
  const model = service();
  const live = createLiveChats({ run: model.run });

  assert.equal(await live.take('t1', saying, free()), undefined);
  assert.equal(model.spawned.length, 0, 'and taking never starts one');

  await live.close();
});

test('a turn for something else than what is standing does not get it', async () => {
  // The agent file edited under a conversation looks exactly like this: same ticket,
  // different key. A process that would answer as the old definition is worse than
  // none, so it goes rather than waiting to be replaced.
  const model = service();
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  assert.equal(await live.take('t1-edited', saying, free()), undefined);
  assert.ok(model.spawned[0]?.signal?.aborted, 'the stale one was let go');
  assert.equal(await live.take('t1', saying, free()), undefined, 'and nothing was left standing');

  await live.close();
});

test('opening another ticket replaces the one standing', async () => {
  const model = service();
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  live.warm('t2', options());

  assert.equal(model.spawned.length, 2);
  assert.ok(model.spawned[0]?.signal?.aborted, 'one at a time, not a pool');
  assert.equal((await live.take('t2', saying, free()))?.text, 'answer to the whole brief');

  await live.close();
});

test('a process that went wrong is not asked a second thing', async () => {
  const model = service(async (prompt, nth) =>
    nth === 1 ? { throws: 'the session ended' } : answers(prompt, nth),
  );
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  const failed = await live.take('t1', saying, free());
  assert.match(
    failed?.failed ?? '',
    /the session ended/,
    'the turn says why, for the caller to fall back on',
  );

  assert.ok(model.spawned[0]?.signal?.aborted, 'and it was let go');
  assert.equal(await live.take('t1', saying, free()), undefined, 'so the next turn goes cold');

  await live.close();
});

test('a session that ends rather than answering is a death like any other', async () => {
  const model = service(async () => undefined);
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  const turn = await live.take('t1', saying, free());
  assert.match(turn?.failed ?? '', /the chat ended/);

  await live.close();
});

test('each turn is charged what it cost, not what the session has cost', async () => {
  // The SDK reports a running total across the turns of a streaming session, so the
  // difference is the turn. Handing back the total would charge the second turn for
  // the first as well, every time.
  const model = service(async (prompt, nth) => ({ text: `answer ${nth}`, total: nth * 0.3 }));
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  assert.equal((await live.take('t1', saying, free()))?.costUsd, 0.3);
  assert.equal(Number((await live.take('t1', saying, free()))?.costUsd.toFixed(2)), 0.3);

  await live.close();
});

test('a turn asked while one is in flight is refused rather than interleaved', async () => {
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const model = service(async (prompt, nth) => {
    if (nth === 1) await held;
    return { text: `answer to ${prompt}` };
  });
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  const inFlight = live.take('t1', saying, free());
  assert.equal(await live.take('t1', saying, free()), undefined, 'one turn at a time');

  answer();
  assert.equal((await inFlight)?.text, 'answer to the whole brief');

  await live.close();
});

test('a turn the manager walked away from takes the process with it', async () => {
  // Closing the pane mid-answer aborts the turn. There is no way to take a half-said
  // turn back, so the session is not one the next turn should be carried on down.
  const model = service(async () => {
    await after(50);
    return { text: 'too late' };
  });
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  const stop = new AbortController();
  const turn = live.take('t1', saying, stop.signal);
  stop.abort();
  await turn.catch(() => {});

  assert.ok(model.spawned[0]?.signal?.aborted);
  assert.equal(await live.take('t1', saying, free()), undefined, 'and nothing is left standing');

  await live.close();
});

test('closing leaves nothing running', async () => {
  const model = service();
  const live = createLiveChats({ run: model.run });

  live.warm('t1', options());
  await live.close();

  assert.ok(model.spawned[0]?.signal?.aborted, 'a stopped workbench holds no subprocess open');

  // Closed first, so anything arriving on the way out starts nothing back up: a
  // fresh subprocess and a five-minute timer is `wb serve` refusing to exit.
  live.warm('t1', options());
  assert.equal(model.spawned.length, 1);
});

test('a pane nobody says anything into is let go', async () => {
  const model = service();
  const live = createLiveChats({ run: model.run, idleMs: 5 });

  live.warm('t1', options());
  await after(30);

  assert.ok(model.spawned[0]?.signal?.aborted, 'a pane left open overnight holds nothing');
  assert.equal(await live.take('t1', saying, free()), undefined);

  await live.close();
});
