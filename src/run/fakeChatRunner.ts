import type { ChatRunner } from './chat.ts';
import { readProposals } from './protocol.ts';

/**
 * A chat that makes no external calls: no model service, no credentials, no cost.
 * The `WB_RUNNER=fake` counterpart of `fakeRunner.ts`, and here for the same reason —
 * the whole path from the pane to an accepted proposal should be exercisable for free.
 *
 * It always proposes one `edit`, and it writes that proposal as a real agent would,
 * in a `wb-propose` block read back by the real reader. A fake that handed over an
 * object directly would leave the reader untested by the one thing that uses it.
 */
export function createFakeChatRunner(): ChatRunner {
  return async function fakeChat({ ticket, message }) {
    const text = [
      `[fake chat] You said: ${message}`,
      '',
      `${ticket.id} is "${ticket.title}", and it is ${ticket.status.replace(/_/g, ' ')}.`,
      'Here is something you could do about it.',
      '',
      '```wb-propose',
      JSON.stringify({
        action: 'edit',
        why: 'the description could say what you just said',
        body: `${ticket.body}\n\n${message}`.trim(),
      }),
      '```',
    ].join('\n');

    return { text, proposals: readProposals(text), costUsd: 0, sessionId: `fake-${ticket.id}` };
  };
}
