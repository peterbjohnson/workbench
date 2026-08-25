import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, type Store } from './store.ts';
import { nextAction } from '../domain/rules.ts';

function running(s: Store): number {
  return s.tickets().filter((t) => t.running).length;
}

function withStore(fn: (s: Store) => void): void {
  const s = openStore(':memory:');
  try {
    fn(s);
  } finally {
    s.close();
  }
}

test('events round-trip through sqlite and derive the same ticket', () => {
  withStore((s) => {
    s.append('t1', { type: 'ticket_created', title: 'a thing', body: 'details' });
    s.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    s.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'the plan',
    });

    const t = s.ticket('t1');
    assert.equal(t.title, 'a thing');
    assert.equal(t.status, 'plan_gate');
    assert.equal(t.plan, 'the plan');
    assert.equal(t.branch, 'wb/t1');
  });
});

test('appended events come back in order with ids and timestamps', () => {
  withStore((s) => {
    s.append('t1', { type: 'ticket_created', title: 'x', body: '' });
    const second = s.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });

    const events = s.eventsFor('t1');
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.type),
      ['ticket_created', 'stage_started'],
    );
    assert.equal(events[1]?.id, second.id);
    assert.ok(events[1]?.at, 'every event carries a timestamp');
  });
});

test('tickets are kept apart', () => {
  withStore((s) => {
    s.append('t1', { type: 'ticket_created', title: 'one', body: '' });
    s.append('t2', { type: 'ticket_created', title: 'two', body: '' });
    s.append('t2', { type: 'stage_started', stage: 'plan', runId: 'r1' });

    assert.deepEqual(s.ticketIds(), ['t1', 't2']);
    assert.equal(s.ticket('t1').status, 'backlog');
    assert.equal(s.ticket('t2').status, 'planning');
  });
});

test('tickets come back in the order they were written, not in id order', () => {
  withStore((s) => {
    for (const id of ['t1', 't2', 't10']) {
      s.append(id, { type: 'ticket_created', title: id, body: '' });
    }
    // Sorted as text, t10 would come second — and "take from the top of the queue"
    // would quietly mean something nobody asked for.
    assert.deepEqual(s.ticketIds(), ['t1', 't2', 't10']);
  });
});

test('a moved ticket comes back where it was put, across every ticket at once', () => {
  withStore((s) => {
    for (const id of ['t1', 't2', 't3']) {
      s.append(id, { type: 'ticket_created', title: id, body: '' });
    }

    // The one thing no ticket's own events can answer: where it sits relative to
    // the others. Read back across all of them, in the order the moves were made.
    s.append('t3', { type: 'moved', before: 't1' });
    assert.deepEqual(s.ticketIds(), ['t3', 't1', 't2']);

    s.append('t3', { type: 'moved', before: null });
    assert.deepEqual(s.ticketIds(), ['t1', 't2', 't3']);
  });
});

test('derived tickets feed the work-in-progress limit', () => {
  withStore((s) => {
    for (const id of ['t1', 't2', 't3']) {
      s.append(id, { type: 'ticket_created', title: id, body: '' });
    }
    assert.equal(running(s), 0);

    s.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    s.append('t2', { type: 'stage_started', stage: 'plan', runId: 'r2' });
    assert.equal(running(s), 2);

    // With two in flight and a limit of two, the third waits.
    const third = nextAction(s.ticket('t3'), running(s), s.policy());
    assert.deepEqual(third, { kind: 'wait' });
  });
});

test('the wip limit is settable and survives in the database', () => {
  withStore((s) => {
    assert.equal(s.policy().wipLimit, 2, 'defaults to two');
    s.setPolicy({ wipLimit: 4 });
    assert.equal(s.policy().wipLimit, 4);
    assert.throws(() => s.setPolicy({ wipLimit: 0 }), /wipLimit/);
  });
});

test('subscribers see each appended event until they unsubscribe', () => {
  withStore((s) => {
    const seen: string[] = [];
    const off = s.subscribe((e) => seen.push(e.type));

    s.append('t1', { type: 'ticket_created', title: 'x', body: '' });
    off();
    s.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });

    assert.deepEqual(seen, ['ticket_created']);
  });
});
