import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createChatRunner, type ChatReply, type ChatRunnerDeps } from './chat.ts';
import type { ChatAgentDef } from '../agents/load.ts';
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
  /** The error the call ends with. Ends cleanly when absent. */
  throws?: string;
};

/** A model service that never leaves the machine. One script per call, in order. */
function service(scripts: Script[]): {
  query: NonNullable<ChatRunnerDeps['query']>;
  /** Every call as it was made, so a test can see what was resumed and what was said. */
  calls: { options: Options; prompt: string }[];
} {
  const calls: { options: Options; prompt: string }[] = [];
  const remaining = [...scripts];

  const query: NonNullable<ChatRunnerDeps['query']> = ({ prompt, options }) => {
    const script = remaining.shift() ?? {};
    calls.push({ options: options ?? {}, prompt: String(prompt) });

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      if (script.text !== undefined || script.cost !== undefined) {
        yield {
          type: 'result',
          subtype: 'success',
          result: script.text ?? '',
          total_cost_usd: script.cost ?? 0,
          session_id: script.session ?? 'session-1',
        } as unknown as SDKMessage;
      }
      if (script.throws !== undefined) throw new Error(script.throws);
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

/** A ticket as the store builds one, so nothing here is a hand-made shape. */
function aTicket(): Ticket {
  const store = openStore(':memory:');
  store.append('t1', { type: 'ticket_created', title: 'a ticket', body: 'do it' });
  const built = store.ticket('t1');
  store.close();
  return built;
}

/** One conversation against a scripted service. `resumeFrom` is what the route passes. */
function chatting(scripts: Script[]): {
  calls: { options: Options; prompt: string }[];
  say: (resumeFrom?: string) => Promise<ChatReply>;
} {
  const model = service(scripts);
  const chat = createChatRunner({
    agent: () => AGENT,
    cwd: () => process.cwd(),
    protectedPaths: [],
    about: '',
    query: model.query,
  });

  return {
    calls: model.calls,
    say: (resumeFrom) =>
      chat({
        ticket: aTicket(),
        events: [],
        message: 'what is this?',
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        signal: new AbortController().signal,
      }),
  };
}

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
  assert.match(chat.calls[1]?.prompt ?? '', /a ticket/, 'briefed from the top, not left to guess');
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
  assert.equal(chat.calls[0]?.prompt, 'what is this?', 'the conversation already holds the rest');
  assert.equal(reply.text, 'still the same ticket');
});
