import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_ACTIONS, proposalEvent, type Proposed } from './proposals.ts';
import { deriveTicket, type Ticket } from './ticket.ts';

function ticket(planned = false): Ticket {
  const t = deriveTicket([
    { type: 'ticket_created', title: 'x', body: '', id: 1, ticketId: 't1', at: '' },
  ]);
  return planned ? { ...t, plan: 'the approved plan' } : t;
}

/** The event a proposal became, or the string it was refused with. */
function outcome(result: Proposed): unknown {
  return 'refused' in result ? result.refused : result.event;
}

test('each action the chat may propose becomes the event that action is', () => {
  const planned = ticket(true);

  assert.deepEqual(
    outcome(proposalEvent(planned, { action: 'edit', why: 'clearer', title: ' Add a retry ' })),
    { type: 'ticket_edited', title: 'Add a retry', body: undefined },
  );
  assert.deepEqual(outcome(proposalEvent(planned, { action: 'queue', why: 'ready' })), {
    type: 'queued',
  });
  assert.deepEqual(outcome(proposalEvent(planned, { action: 'backlog', why: 'not yet' })), {
    type: 'backlogged',
  });
  assert.deepEqual(outcome(proposalEvent(planned, { action: 'approve', why: 'sound' })), {
    type: 'plan_approved',
  });
  assert.deepEqual(
    outcome(proposalEvent(planned, { action: 'changes', why: 'nearly', text: ' fix the retry ' })),
    { type: 'changes_requested', changes: 'fix the retry' },
  );
  assert.deepEqual(
    outcome(
      proposalEvent(planned, { action: 'reject', why: 'wrong shape', text: 'wrong problem' }),
    ),
    { type: 'plan_rejected', reason: 'wrong problem' },
  );
});

test('an action outside the list is refused, and the refusal names what is allowed', () => {
  for (const action of ['ship', 'cancel', 'answer', 'delete', '']) {
    const refused = proposalEvent(ticket(), { action, why: 'because' });
    assert.ok('refused' in refused, action);
    for (const allowed of CHAT_ACTIONS) assert.match(refused.refused, new RegExp(allowed));
  }
});

test('a proposal that breaks its own action rule is refused with the reason', () => {
  // The same refusals the equivalent routes give, said the same way.
  assert.deepEqual(
    outcome(proposalEvent(ticket(), { action: 'edit', why: 'x' })),
    'nothing to change',
  );
  assert.deepEqual(
    outcome(proposalEvent(ticket(), { action: 'edit', why: 'x', title: '  ' })),
    'a ticket needs a title',
  );
  assert.deepEqual(
    outcome(proposalEvent(ticket(true), { action: 'changes', why: 'x', text: ' ' })),
    'say what to put right',
  );
  assert.deepEqual(
    outcome(proposalEvent(ticket(true), { action: 'reject', why: 'x' })),
    'say why, so the next plan knows',
  );
});

test('changes are refused on a ticket that has not been planned', () => {
  assert.deepEqual(
    outcome(proposalEvent(ticket(), { action: 'changes', why: 'x', text: 'fix it' })),
    'nothing has been planned yet — send it back instead',
  );
});

test('an edit may change the description alone, leaving the title', () => {
  assert.deepEqual(outcome(proposalEvent(ticket(), { action: 'edit', why: 'x', body: 'more' })), {
    type: 'ticket_edited',
    title: undefined,
    body: 'more',
  });
});
