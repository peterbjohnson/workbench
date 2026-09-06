import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conflictBrief, conflictHeading } from './conflicts.ts';
import { deriveTicket, type Ticket } from './ticket.ts';

const PATHS = ['src/api/server.ts', 'ui/src/Detail.tsx'];

/** A ticket parked on a clash, as the panel finds it. */
function blocked(conflictedWith?: { ref: string; base: string }): Ticket {
  return deriveTicket([
    { type: 'ticket_created', title: 'x', body: '', id: 1, ticketId: 't36', at: '' },
    {
      type: 'blocked',
      reason: 'this branch conflicts',
      conflicts: PATHS,
      conflictedWith,
      id: 2,
      ticketId: 't36',
      at: '',
    },
  ]);
}

test('a clash with the base names the commit the base moved on to', () => {
  const t = blocked({ ref: '1a2b3c4d5e6f', base: '1a2b3c4d5e6f' });

  assert.equal(conflictHeading(t), 'Conflicts with the base at 1a2b3c4d');
  assert.match(
    conflictBrief(t),
    /^The base has moved on and this branch no longer merges into it\./,
  );
});

test('a clash with work the ticket waits for names that branch, not the base', () => {
  // t36 on the FamilyTree board: blocked against wb/t37, under a heading that said
  // the base and a brief that told the implement run the base had moved on.
  const t = blocked({ ref: 'wb/t37', base: '1a2b3c4d5e6f' });

  assert.equal(conflictHeading(t), 'Conflicts with wb/t37, the work this ticket waits for');
  assert.equal(
    conflictBrief(t).split('\n')[0],
    'This branch no longer merges with wb/t37, the work it waits for. Resolve the conflicts in:',
  );
  assert.doesNotMatch(conflictBrief(t), /base has moved on/);
});

test('a clash recorded before this was kept says what it always said', () => {
  const t = blocked();

  assert.equal(conflictHeading(t), 'Conflicts with the base');
  assert.match(conflictBrief(t), /^The base has moved on/);
});

test('the brief lists the files to resolve, whatever the clash was with', () => {
  for (const t of [blocked(), blocked({ ref: 'wb/t37', base: 'aaaa1111' })]) {
    assert.equal(
      conflictBrief(t).split('Resolve the conflicts in:\n')[1],
      '- src/api/server.ts\n- ui/src/Detail.tsx',
    );
  }
});
