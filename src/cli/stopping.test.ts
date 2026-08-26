import { test } from 'node:test';
import assert from 'node:assert/strict';

import { abandoning, draining } from './stopping.ts';
import type { Ticket } from '../domain/ticket.ts';

/** Only the parts of a ticket a stopping message reads. */
function running(id: string, stage: Ticket['stage'], costUsd: number): Ticket {
  return { id, stage, costUsd, running: true } as Ticket;
}

test('a stop with nothing running says so and stops', () => {
  assert.equal(draining([]), 'nothing in flight. Stopping.');
  assert.equal(abandoning([]), 'stopped.');
});

test('a stop names what it is waiting for, and what it has cost', () => {
  const said = draining([running('t12', 'implement', 3.4), running('t14', 'review', 0.2)]);

  assert.match(said, /finishing 2 stages before stopping/);
  assert.match(said, /t12 {2}implement {2}\$3\.40 so far/);
  // Lined up: the costs are being compared, so they start in the same column.
  assert.match(said, /implement {2}\$3\.40[\s\S]*review {5}\$0\.20/);
  assert.match(said, /t14 {2}review {5}\$0\.20 so far/);
});

test('a stop says what ending it early would throw away', () => {
  // The second Ctrl-C is the expensive one, so the first must say so. Without this
  // the wait is silent and ending it looks free.
  const said = draining([running('t12', 'implement', 3.4)]);

  assert.match(said, /Ctrl-C again/);
  assert.match(said, /runs again from the top/);
  assert.match(said, /what it has spent is spent/);
});

test('one stage is not "1 stages"', () => {
  assert.match(draining([running('t12', 'implement', 1)]), /finishing 1 stage before/);
  assert.match(abandoning([running('t12', 'implement', 1)]), /abandoning 1 stage: t12\./);
});

test('a stage that has spent very little still says a number', () => {
  // "$0" would read as nothing at stake, which is not the same as a few cents.
  assert.match(draining([running('t12', 'plan', 0.004)]), /\$0\.00 so far/);
});

test('a stage with no stage recorded is still named', () => {
  assert.match(draining([running('t12', null, 1)]), /t12 {2}a stage {2}\$1\.00/);
});

test('abandoning names every ticket it gave up on', () => {
  const said = abandoning([running('t12', 'implement', 3.4), running('t14', 'review', 0.2)]);

  assert.match(said, /abandoning 2 stages: t12, t14\./);
  assert.match(said, /starts again from the top/);
});
