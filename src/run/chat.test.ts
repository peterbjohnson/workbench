import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  HookInput,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { createChatRunner, type ChatReply, type ChatRunnerDeps } from './chat.ts';
import type { ChatAgentDef } from '../agents/load.ts';
import type { Event } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { openStore } from '../store/store.ts';

/**
 * What one call to the model service does: answers, and then either ends or throws.
 * Throwing is how the SDK reports a resume it could not find a session for, which is
 * the ending this runner has to survive.
 */
type Script = {
  /** The reply, when there is one. Nothing is said at all when both this and `cost` are absent. */
  text?: string;
  cost?: number;
  session?: string;
  /** How the turn ended, when it did not end well. `success` when absent. */
  subtype?: string;
  /** The error the call ends with. Ends cleanly when absent. */
  throws?: string;
};

/**
 * One subprocess: what was asked of it, and everything it was told, in order.
 * `started` is whether anything ever pulled on it — the SDK spawns nothing until
 * something does, so a call that was made and never read is a process that never was.
 */
type Call = { options: Options; prompts: string[]; started: boolean };

/**
 * A model service that never leaves the machine. One script per turn, in order —
 * and a turn is one thing said down one process, which for a living process is
 * several per call and for a cold one is the only thing it ever hears.
 */
function service(scripts: Script[]): {
  query: NonNullable<ChatRunnerDeps['query']>;
  /** Every call as it was made, so a test can see what was resumed and what was said. */
  calls: Call[];
} {
  const calls: Call[] = [];
  const remaining = [...scripts];

  async function* answer(script: Script): AsyncGenerator<SDKMessage, void> {
    if (script.text !== undefined || script.cost !== undefined || script.subtype !== undefined) {
      yield {
        type: 'result',
        subtype: script.subtype ?? 'success',
        result: script.text ?? '',
        total_cost_usd: script.cost ?? 0,
        session_id: script.session ?? 'session-1',
      } as unknown as SDKMessage;
    }
    if (script.throws !== undefined) throw new Error(script.throws);
  }

  const query: NonNullable<ChatRunnerDeps['query']> = ({ prompt, options }) => {
    const call: Call = { options: options ?? {}, prompts: [], started: false };
    calls.push(call);

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      call.started = true;
      // A string is one turn and then the process is gone, which is what a cold
      // spawn is. A stream is a process being kept, and it is read until whoever
      // holds it lets go.
      if (typeof prompt === 'string') {
        call.prompts.push(prompt);
        yield* answer(remaining.shift() ?? {});
        return;
      }
      for await (const said of prompt as AsyncIterable<SDKUserMessage>) {
        call.prompts.push(String(said.message.content));
        const script = remaining.shift();
        // A living process with nothing left scripted is one that has died, which
        // is what the runner has to fall back from.
        if (script === undefined) return;
        yield* answer(script);
      }
    }

    return messages() as ReturnType<NonNullable<ChatRunnerDeps['query']>>;
  };

  return { query, calls };
}

const AGENT: ChatAgentDef = {
  model: 'a-model',
  effort: 'low',
  permissionMode: 'default',
  maxTurns: 4,
  maxBudgetUsd: 1,
  allowedTools: ['Read'],
  disallowedTools: [],
  instructions: 'talk about the ticket',
};

/** One turn of a conversation already had about the ticket, as the route stored it. */
type Said = { role: 'manager' | 'agent'; text: string };

/**
 * A ticket and its history as the store builds them, so nothing here is a hand-made
 * shape — including the conversation, which is only ever read back out of events.
 */
function aTicket(said: Said[] = []): { ticket: Ticket; events: readonly Event[] } {
  const store = openStore(':memory:');
  store.append('t1', { type: 'ticket_created', title: 'a ticket', body: 'do it' });
  for (const turn of said) store.append('t1', { type: 'chat_said', ...turn });
  const built = { ticket: store.ticket('t1'), events: store.eventsFor('t1') };
  store.close();
  return built;
}

/**
 * One conversation about one ticket, against a scripted service. `resumeFrom` is
 * what the route passes; `warm` is the pane being opened, which every test that
 * wants a living process has to do first — nothing else starts one.
 */
function chatting(
  scripts: Script[],
  agent: () => ChatAgentDef = () => AGENT,
  said: Said[] = [],
): {
  calls: Call[];
  warm: () => void;
  close: () => Promise<void>;
  say: (resumeFrom?: string) => Promise<ChatReply>;
} {
  const model = service(scripts);
  const { ticket, events } = aTicket(said);
  const chats = createChatRunner({
    agent,
    cwd: () => process.cwd(),
    protectedPaths: [],
    about: '',
    query: model.query,
  });

  return {
    calls: model.calls,
    warm: () => chats.warm(ticket),
    close: chats.close,
    say: (resumeFrom) =>
      chats.chat({
        ticket,
        events,
        message: 'what is this?',
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        signal: new AbortController().signal,
      }),
  };
}

/** What a turn's hook says about reading a file, which is the only guard there is. */
function reading(
  options: Options,
  file_path: string,
): Promise<{
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  assert.ok(hook, 'every process watches its tool calls');
  return hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } } as HookInput,
    undefined,
    { signal: new AbortController().signal },
  ) as ReturnType<typeof reading>;
}

test('the chat reads only where it was pointed', async () => {
  // `Read` is granted, and a granted tool is auto-approved before `canUseTool` is
  // ever consulted, so the hook is the only thing between a chat and the rest of
  // this machine — and whatever it read would come back in the reply, which is
  // appended to the ticket and kept. It matters most on a ticket that has not
  // started, where there is no worktree yet and the chat is reading the repository.
  const chat = chatting([{ text: 'had a look' }]);
  await chat.say();
  const options = chat.calls[0]?.options ?? {};

  assert.deepEqual(
    await reading(options, 'src/run/chat.ts'),
    {},
    'where it is reading is its business',
  );

  const refused = await reading(options, '~/.aws/credentials');
  assert.equal(refused.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    refused.hookSpecificOutput?.permissionDecisionReason ?? '',
    /outside this ticket's workspace/,
  );
});

test('a turn that could not pick its session up starts the conversation again', async () => {
  // The session lives in ~/.claude/projects under the path it was started from, so
  // queueing a ticket loses it: the cwd moves to the worktree. Throwing here would
  // leave the stored session in place and every later turn repeating the same doomed
  // resume, which is a chat broken for that ticket for good.
  const chat = chatting([
    { throws: 'no conversation found with that id' },
    { text: 'it is about the ticket', session: 'session-2' },
  ]);

  const reply = await chat.say('session-gone');

  assert.equal(chat.calls.length, 2, 'it tried again');
  assert.equal(chat.calls[0]?.options.resume, 'session-gone');
  assert.equal(chat.calls[1]?.options.resume, undefined, 'the second attempt is a fresh one');
  assert.match(
    chat.calls[1]?.prompts[0] ?? '',
    /a ticket/,
    'briefed from the top, not left to guess',
  );
  assert.equal(reply.text, 'it is about the ticket');
  assert.equal(reply.sessionId, 'session-2', 'and the dead session is replaced, not kept');
});

test('a resumed turn that spent money before failing is not paid for twice', async () => {
  // A run that reached the model had its session, so its ending is the turn's answer.
  const chat = chatting([{ cost: 0.4, throws: 'reached its cost limit' }]);

  await assert.rejects(chat.say('session-1'), /reached its cost limit/);
  assert.equal(chat.calls.length, 1, 'it did not run the turn again');
});

test('a resumed turn that answers is told the message alone', async () => {
  const chat = chatting([{ text: 'still the same ticket' }]);

  const reply = await chat.say('session-1');

  assert.equal(chat.calls.length, 1);
  assert.equal(
    chat.calls[0]?.prompts[0],
    'what is this?',
    'the conversation already holds the rest',
  );
  assert.equal(reply.text, 'still the same ticket');
});

test('two turns after the pane is opened go down one process, and neither reloads a session', async () => {
  // What the ticket asks for, end to end: the wait is paid when the pane opens, the
  // first turn spends it, and the second costs what it costs to answer and nothing
  // to ask. The route passes the session it stored after turn one, and the living
  // process wins over it — it never left, so there is nothing to pick back up.
  const chat = chatting([{ text: 'it is about the ticket' }, { text: 'and about that too' }]);

  chat.warm();
  assert.equal(chat.calls.length, 1, 'opening the pane started one');
  assert.deepEqual(chat.calls[0]?.prompts, [], 'before a word had been said to it');

  assert.equal((await chat.say()).text, 'it is about the ticket');
  assert.equal((await chat.say('session-1')).text, 'and about that too');

  assert.equal(chat.calls.length, 1, 'both turns went down the one process');
  assert.equal(chat.calls[0]?.options.resume, undefined, 'neither had a session to reload');
  assert.match(chat.calls[0]?.prompts[0] ?? '', /a ticket/, 'the first turn briefed it');
  assert.equal(chat.calls[0]?.prompts[1], 'what is this?', 'and it held the brief after that');

  await chat.close();
});

/** Long enough for a generator that has been asked for something to start running. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('opening the pane pulls on the process, so the boot is paid before anything is said', async () => {
  // The SDK does boot against a stream nobody has asked anything of — measured — so
  // this is not what makes warming work today. It is what would notice if that
  // stopped being true: nothing else here would, and what the manager would get is
  // the slow first turn this was all written for.
  const chat = chatting([{ text: 'ready when you are' }]);

  chat.warm();
  await tick();

  assert.equal(chat.calls.length, 1, 'opening the pane started one');
  assert.equal(chat.calls[0]?.started, true, 'and asked it for its first word');
  assert.deepEqual(chat.calls[0]?.prompts, [], 'before a word had been said to it');

  await chat.close();
});

test('a process started fresh is told the conversation the pane is showing', async () => {
  // Warming spawns a process that has been nowhere, and it wins over `resumeFrom` —
  // so the first turn after a pane is reopened is answered by something that has seen
  // none of the conversation above it unless the brief carries it. A fast turn that
  // has forgotten what was being talked about is worse than the slow one it replaced.
  const chat = chatting([{ text: 'still about the ticket' }], () => AGENT, [
    { role: 'manager', text: 'why is it stuck?' },
    { role: 'agent', text: 'the verify stage sent it back' },
    // The route writes what the manager just said before the runner is called, so
    // the last turn is always the message that is a section of the brief already.
    { role: 'manager', text: 'what is this?' },
  ]);

  chat.warm();
  await chat.say('session-1');

  const briefed = chat.calls[0]?.prompts[0] ?? '';
  assert.equal(chat.calls.length, 1, 'the warmed process took it');
  assert.match(briefed, /why is it stuck\?/, 'what was asked before');
  assert.match(briefed, /the verify stage sent it back/, 'and what was answered');
  assert.equal(
    briefed.split('what is this?').length - 1,
    1,
    'and what was just said is in it once, not as history as well',
  );

  await chat.close();
});

test('a turn is charged the running total moving, and a total that restarts is charged whole', async () => {
  // The SDK reports `total_cost_usd` cumulatively across the turns of a streaming
  // session, so a turn costs the difference — charging the total would bill the
  // second turn for the first as well. It says a lower one means the total restarted
  // rather than that money came back, so the whole of what it now says is this turn.
  const chat = chatting([
    { text: 'first', cost: 0.5 },
    { text: 'second', cost: 0.8 },
    { text: 'third', cost: 0.2 },
  ]);

  chat.warm();
  assert.equal((await chat.say()).costUsd, 0.5, 'the first turn is the whole of the total');
  assert.equal(
    Number((await chat.say('session-1')).costUsd.toFixed(2)),
    0.3,
    'the second is what the total moved by, not what it says',
  );
  assert.equal(
    (await chat.say('session-1')).costUsd,
    0.2,
    'and a restarted total is that turn, not nothing',
  );

  assert.equal(chat.calls.length, 1, 'all three down the one process');
  await chat.close();
});

test('a turn down a process that has died falls back and still answers', async () => {
  // A living process can be gone by the time it is spoken to — the machine slept,
  // the session ended, a boot that got nowhere. The manager is sitting in front of
  // the pane, so the turn goes the way every turn went before: spawn and resume.
  const chat = chatting([{ throws: 'the session ended' }, { text: 'answered anyway' }]);

  chat.warm();
  const reply = await chat.say('session-1');

  assert.equal(chat.calls.length, 2, 'a fresh one answered it');
  assert.equal(chat.calls[1]?.options.resume, 'session-1', "today's spawn-and-resume, exactly");
  assert.equal(reply.text, 'answered anyway');

  await chat.close();
});

test('a living turn that spent money before stopping is not paid for twice', async () => {
  // The chat reaching its own budget is an ending, not a process that failed to
  // serve: it got to the model, so that is the turn. Falling back here would spawn
  // a second process to spend the same money again.
  const chat = chatting([{ cost: 0.4, subtype: 'error_max_budget_usd' }]);

  chat.warm();
  await assert.rejects(chat.say('session-1'), /the chat stopped: error_max_budget_usd/);
  assert.equal(chat.calls.length, 1, 'it did not run the turn again');

  await chat.close();
});

test('editing the chat agent between turns retires the process rather than serving it stale', async () => {
  // The board edits `chat.md` like the other four, and a process cannot be told
  // about it: what it was started with is what it will answer as. So it goes, and
  // the turn that found it stale runs on one started from the file as it now reads.
  let agent: ChatAgentDef = AGENT;
  const chat = chatting([{ text: 'as it was' }, { text: 'as it is now' }], () => agent);

  chat.warm();
  assert.equal((await chat.say()).text, 'as it was');

  agent = { ...AGENT, instructions: 'talk about it differently' };
  const reply = await chat.say();

  assert.equal(chat.calls.length, 2, 'the stale process could not serve it');
  assert.equal(chat.calls[0]?.prompts.length, 1, 'and was not asked a second thing');
  assert.match(chat.calls[1]?.prompts[0] ?? '', /talk about it differently/, 'the new file ran');
  assert.equal(reply.text, 'as it is now');

  await chat.close();
});

test('a living process is started with the same guard as a cold one', async () => {
  // Keeping a process between turns must not widen what the chat can reach. What it
  // may reach is settled at spawn and cannot be changed after, so this is the only
  // place it could go wrong — and the first test in this file is what the hook then
  // does with the answer.
  const chat = chatting([{ text: 'live' }, { text: 'cold' }]);

  chat.warm();
  await chat.say();
  // Closed, so the next turn has no living process to take and goes the cold way.
  await chat.close();
  await chat.say('session-1');

  const live = chat.calls[0]?.options ?? {};
  const cold = chat.calls[1]?.options ?? {};
  assert.equal(chat.calls.length, 2, 'one of each to compare');

  assert.deepEqual(live.allowedTools, cold.allowedTools, 'the same tool grant');
  assert.deepEqual(live.disallowedTools, cold.disallowedTools);
  assert.deepEqual(Object.keys(live.mcpServers ?? {}), Object.keys(cold.mcpServers ?? {}));
  assert.equal(live.cwd, cold.cwd, 'reading in the same place');
  assert.equal(live.permissionMode, cold.permissionMode);
  assert.deepEqual(
    live.settingSources,
    cold.settingSources,
    'nothing from this machine either way',
  );

  for (const [which, options] of [
    ['the living one', live],
    ['the cold one', cold],
  ] as const) {
    const refused = await reading(options, '~/.aws/credentials');
    assert.equal(
      refused.hookSpecificOutput?.permissionDecision,
      'deny',
      `${which} reads only where it was pointed`,
    );
  }
});
