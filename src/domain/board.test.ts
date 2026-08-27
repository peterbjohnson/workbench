import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  changesStand,
  chatTurns,
  COLUMNS,
  columnFor,
  details,
  grouped,
  headline,
  inColumn,
  madeInto,
  needsYou,
  ordered,
  rejectionStands,
  runs,
  sendableBack,
  statusOf,
  suggestion,
  toneOf,
  tweakable,
  waitingForSlot,
  withoutProposals,
  type Run,
} from './board.ts';
import type { Event, EventBody } from './events.ts';
import { awaitedWork, carriedWork, heldBy } from './rules.ts';
import { deriveTicket, ended, type Status, type Ticket } from './ticket.ts';

const EVERY_STATUS = [
  'backlog',
  'queued',
  'planning',
  'plan_gate',
  'implementing',
  'reviewing',
  'verifying',
  'ready_for_pr',
  'awaiting_verdict',
  'blocked',
  'cancelled',
  'gave_up',
  'done',
] as const satisfies readonly Status[];

/**
 * Fails to compile if a status is added and left out above — which is the point:
 * the list below is only exhaustive because this line says it has to be.
 */
const _covered: Exclude<Status, (typeof EVERY_STATUS)[number]> extends never ? true : false = true;

function at(status: Status, stage: Ticket['stage'] = null): Ticket {
  const t = deriveTicket([
    { type: 'ticket_created', title: 'x', body: '', id: 1, ticketId: 't1', at: '' },
  ]);
  return { ...t, status, stage };
}

test('every status has exactly one column', () => {
  for (const status of EVERY_STATUS) {
    const holding = COLUMNS.filter((c) => c.statuses.includes(status));
    // Blocked is the one exception: it has no column of its own, because a stuck
    // ticket has not moved anywhere. It is drawn in the column of the stage it
    // stopped in, which is what `columnFor` works out.
    assert.equal(holding.length, status === 'blocked' ? 0 : 1, status);
  }
});

test('a blocked ticket stays in the column of the stage it stopped in', () => {
  assert.equal(columnFor(at('blocked', 'implement')), 'Building');
  assert.equal(columnFor(at('blocked', 'plan')), 'Planning');
  assert.equal(columnFor(at('blocked', null)), 'Committed', 'stuck before anything ran');
});

function card(id: string, status: Status): Ticket {
  return { ...at(status), id };
}

test('a column reads in board order, or from the other end', () => {
  const board = [
    card('t1', 'done'),
    card('t2', 'backlog'),
    card('t3', 'cancelled'),
    card('t4', 'gave_up'),
  ];

  const ids = (order?: Parameters<typeof inColumn>[2]) =>
    inColumn(board, 'Done', order).map((t) => t.id);

  assert.deepEqual(ids(), ['t1', 't3', 't4'], 'board order by default');
  assert.deepEqual(ids('oldest'), ['t1', 't3', 't4']);
  assert.deepEqual(ids('newest'), ['t4', 't3', 't1']);
  // The board itself is untouched — the filtered copy is what gets reversed.
  assert.deepEqual(
    board.map((t) => t.id),
    ['t1', 't2', 't3', 't4'],
  );
});

test('one ticket or none reads the same either way', () => {
  const one = [card('t1', 'done')];
  assert.deepEqual(inColumn(one, 'Done', 'newest'), one);
  assert.deepEqual(inColumn(one, 'Done', 'oldest'), one);
  assert.deepEqual(inColumn([], 'Done', 'newest'), []);
});

test('another column keeps the board order whatever is asked of it', () => {
  const board = [card('t1', 'backlog'), card('t2', 'done'), card('t3', 'backlog')];
  assert.deepEqual(
    inColumn(board, 'Backlog').map((t) => t.id),
    ['t1', 't3'],
  );
});

test('needing you is the gate and being stuck, and nothing else', () => {
  const waiting = EVERY_STATUS.filter((s) => needsYou(at(s)));
  assert.deepEqual(waiting, ['plan_gate', 'blocked']);
});

test('every status says where the ticket is and what happens next', () => {
  for (const status of EVERY_STATUS) {
    const { state, detail } = headline(at(status));
    assert.notEqual(state, '', status);
    assert.notEqual(detail, '', status);
  }
});

test('the headline is what the panel is opened to find out', () => {
  assert.deepEqual(headline(at('plan_gate')), {
    state: 'Waiting on you',
    detail: 'approve the plan, or send it back',
    tone: 'note',
  });

  // The case this was written for: a ticket in a pull request said nothing about
  // being in one, and led with whatever had sent it back three stages ago.
  assert.deepEqual(headline({ ...at('awaiting_verdict'), rejection: 'wrong problem' }), {
    state: 'Offered',
    detail: 'waiting on the pull request',
    tone: 'going',
  });

  // Stuck asking and stuck fallen-over need different things done about them.
  const stuck = at('blocked', 'implement');
  const asked = { ...stuck, question: { question: 'which units?', reasoning: 'two are used' } };
  assert.equal(headline(asked).state, 'Waiting on you');
  assert.equal(headline(asked).detail, 'an agent asked you something');
  assert.equal(headline(stuck).state, 'Stuck');
  assert.equal(headline(stuck).tone, 'bad');

  // A running stage says how far it has got — the answer to twenty minutes of
  // "running" — and one merely waiting for a slot does not claim to be going.
  const reviewing = { ...at('reviewing'), steps: ['a', 'b', 'c', 'd', 'e'], step: 2 };
  assert.equal(headline({ ...reviewing, running: true }).detail, 'review is running, step 2/5');
  assert.equal(headline({ ...reviewing, running: true, step: null }).detail, 'review is running');
  assert.equal(headline(reviewing).detail, 'waiting for a slot to review');

  // A ticket held behind another is not waiting for a slot, and its card already
  // says so — the block the ticket asked to be the one you trust must not
  // contradict the card about the same ticket.
  const waiting = { ...at('queued'), waitsFor: ['t3'] };
  const other = { ...at('queued'), id: 't3' };
  assert.equal(headline(waiting, heldBy(waiting, [waiting, other])).detail, 'waiting for t3');
  assert.equal(headline(waiting, []).detail, 'waiting for a slot to plan', 'once it is let go');
});

test('a rejection stands only while the ticket is doing something about it', () => {
  const standing = EVERY_STATUS.filter((s) => rejectionStands(at(s)));
  assert.deepEqual(standing, ['planning', 'plan_gate']);
  assert.equal(rejectionStands(at('blocked', 'plan')), true, 'stuck part-way through replanning');
  assert.equal(rejectionStands(at('blocked', 'implement')), false);

  // The gate counts because `plan_approved` is what clears a rejection: until
  // then the plan sitting at the gate is the answer to it, and you cannot judge
  // the answer with the objection folded away under Earlier.

  // Everywhere else it is history. Neither is cleared until the stage answering
  // it lands — the brief and the hand-over message read them — so this is the
  // only thing keeping a rejection three stages old from being the loudest line
  // on the ticket.
  assert.equal(rejectionStands({ ...at('awaiting_verdict'), rejection: 'wrong problem' }), false);

  const changing = EVERY_STATUS.filter((s) => changesStand(at(s)));
  assert.deepEqual(changing, ['implementing']);
  assert.equal(changesStand(at('blocked', 'implement')), true);
  assert.equal(changesStand(at('blocked', 'plan')), false);
});

function one(body: EventBody, i = 0): Event {
  return { ...body, id: i + 1, ticketId: 't1', at: `2026-08-05T0${i}` };
}

function log(...bodies: EventBody[]): Event[] {
  return bodies.map(one);
}

test('a ticket history folds into one block per stage run', () => {
  const summarised = runs(
    log(
      { type: 'ticket_created', title: 'x', body: '' },
      { type: 'queued' },
      { type: 'stage_started', stage: 'plan', runId: 'r1' },
      { type: 'tool_requested', runId: 'r1', tool: 'Read', input: {}, allowed: true },
      { type: 'tool_requested', runId: 'r1', tool: 'Write', input: {}, allowed: false },
      {
        type: 'stage_finished',
        runId: 'r1',
        outcome: 'completed',
        summary: 'a plan',
        costUsd: 0.4,
      },
      { type: 'stage_started', stage: 'verify', runId: 'r2' },
      {
        type: 'checks_run',
        runId: 'r2',
        results: [
          { command: 'a', ok: true, output: '' },
          { command: 'b', ok: false, output: 'boom' },
        ],
      },
    ),
  );

  assert.equal(summarised.length, 2, 'events outside a run belong to no run');

  assert.deepEqual(summarised[0]?.refused, ['Write'], 'a refusal is named, not counted');
  assert.equal(summarised[0]?.toolCalls, 2);
  assert.equal(summarised[0]?.costUsd, 0.4);

  assert.deepEqual(summarised[1]?.checks, { passed: 1, failed: 1 });
  assert.equal(summarised[1]?.outcome, 'running', 'a run with no end is still going');
});

test('an event opens to what its line does not say, and to nothing it does', () => {
  const refused = one({
    type: 'tool_requested',
    runId: 'r1',
    tool: 'Write',
    input: { file_path: 'workbench/rules.ts' },
    allowed: false,
    reason: 'protected',
  });

  assert.deepEqual(details(refused), [
    ['tool', 'Write'],
    ['input', '{\n  "file_path": "workbench/rules.ts"\n}'],
    ['allowed', 'false'],
    ['reason', 'protected'],
  ]);

  // Nothing behind a line that is already all of it — because the event carries
  // nothing, or because the line is already saying the only thing it does.
  assert.deepEqual(details(one({ type: 'plan_approved' })), []);
  assert.deepEqual(details(one({ type: 'stage_started', stage: 'plan', runId: 'r1' }), 'plan'), []);
});

test("a turn's tool calls are one line of the log, which opens on to them", () => {
  const call = (tool: string, runId = 'r1', allowed = true): EventBody => ({
    type: 'tool_requested',
    runId,
    tool,
    input: {},
    allowed,
  });

  const items = grouped(
    log(
      { type: 'stage_started', stage: 'plan', runId: 'r1' },
      { type: 'agent_said', runId: 'r1', text: 'looking' },
      call('Read'),
      call('Read'),
      call('Grep', 'r1', false),
      // Words between two calls are a turn boundary, so the group stops here.
      { type: 'agent_said', runId: 'r1', text: 'now writing' },
      call('Write'),
      // Another run's calls are another group, adjacent or not.
      call('Read', 'r2'),
      call('Read', 'r2'),
    ),
  );

  assert.deepEqual(
    items.map((i) => (i.kind === 'one' ? i.event.type : `${i.calls.length}: ${i.said}`)),
    [
      'stage_started',
      'agent_said',
      '3: Read ×2, Grep',
      'agent_said',
      // One call on its own stays a plain line — a triangle over one row buys nothing.
      'tool_requested',
      '2: Read ×2',
    ],
  );

  const burst = items[2];
  assert.equal(burst?.kind === 'tools' && burst.refused, 1, 'a refusal is counted on the line');
  assert.equal(burst?.kind === 'tools' && burst.runId, 'r1');
  assert.equal(burst?.kind === 'tools' && burst.at, '2026-08-05T02', 'the group is when it began');

  assert.deepEqual(grouped([]), [], 'nothing folds to nothing');
});

test('a run that rejected the work did not just complete', () => {
  const run = (over: Partial<Run>): Run => ({
    stage: 'review',
    outcome: 'completed',
    summary: '',
    rejected: null,
    changes: null,
    question: null,
    costUsd: 0,
    toolCalls: 0,
    refused: [],
    checks: null,
    later: [],
    at: '',
    ...over,
  });

  // The distinction the outcome cannot make: both of these completed.
  assert.equal(statusOf(run({})), 'done');
  assert.equal(statusOf(run({ rejected: 'wrong problem' })), 'did not approve');

  assert.equal(statusOf(run({ outcome: 'running' })), 'running');
  assert.equal(statusOf(run({ outcome: 'failed' })), 'failed');
  assert.equal(statusOf(run({ outcome: 'blocked' })), 'asked you');
  assert.equal(statusOf(run({ checks: { passed: 1, failed: 2 } })), 'checks failed');

  // The workbench stopping under a run is neither of the two it would otherwise
  // fall into: not `failed`, because nothing went wrong, and not `done`, because
  // it did not finish. Both were wrong on the panel in different directions.
  assert.equal(statusOf(run({ outcome: 'interrupted' })), 'stopped');
  assert.equal(toneOf(run({ outcome: 'interrupted' })), 'note');

  // A review that sent the work back to be fixed did not merely finish. Without
  // this it read as `done`, and the implement stage after it looked unexplained.
  assert.equal(statusOf(run({ changes: '- the units are wrong' })), 'asked for changes');

  // And it is neither good news nor bad: the work was sound and is being finished.
  assert.equal(toneOf(run({ changes: '- the units are wrong' })), 'note');
  assert.equal(toneOf(run({})), 'ok');
  assert.equal(toneOf(run({ rejected: 'wrong problem' })), 'bad');
  assert.equal(toneOf(run({ outcome: 'failed' })), 'bad');
  assert.equal(toneOf(run({ checks: { passed: 0, failed: 1 } })), 'bad');
  assert.equal(toneOf(run({ outcome: 'running' })), 'going');
});

test('a stage the workbench died in ends that stage, rather than adding a run', () => {
  // `reconcile` closes an interrupted run off under an id no start ever had. It is
  // the report that this stage stopped, not a run of its own.
  const summarised = runs(
    log(
      { type: 'stage_started', stage: 'implement', runId: 'r1' },
      {
        type: 'stage_finished',
        runId: 'interrupted',
        outcome: 'interrupted',
        summary: 'the workbench stopped while this stage was running',
      },
    ),
  );

  assert.equal(summarised.length, 1);
  assert.equal(summarised[0]?.stage, 'implement');
  assert.equal(summarised[0]?.outcome, 'interrupted');
});

test('a suggestion is a named ticket, and its description is what the stage said', () => {
  const source = { ...at('reviewing'), id: 't16', title: 'Assert report structure' };
  const idea = 'Drop the units table — section 3 already says all of it, in its own words.';

  const { title, what, body } = suggestion(source, 'review', idea);
  assert.equal(title, 'Drop the units table');
  assert.equal(what, 'section 3 already says all of it, in its own words.');
  assert.equal(body, `${what}\n\nSuggested by review of t16 — Assert report structure.`);

  // A stage that did not name its idea gets a name anyway: a paragraph must not
  // become a ticket title, a branch name and a merge commit subject. Nor may a
  // dash halfway down one count as the name ending — every real suggestion this
  // was built on has one somewhere.
  for (const paragraph of [`${'word '.repeat(40)}end`, `${'word '.repeat(40)}— end`]) {
    const unnamed = suggestion(source, 'review', paragraph);
    assert.ok(unnamed.title.length <= 60, unnamed.title);
    assert.ok(unnamed.what.endsWith('end'), unnamed.what);
  }
});

test('a suggestion already made into a ticket is recognised as that ticket', () => {
  const source = { ...at('reviewing'), id: 't16', title: 'Assert report structure' };
  const idea = 'Drop the units table — section 3 already says all of it.';

  const made = (title: string, body: string, status: Status = 'queued'): Ticket => ({
    ...at(status),
    id: 't17',
    title,
    body,
  });

  const { title, body } = suggestion(source, 'review', idea);
  const ticket = made(title, body);
  assert.equal(madeInto([ticket], source, 'review', idea)?.id, 't17');

  // Nothing on the board yet: the buttons are still the right thing to show.
  assert.equal(madeInto([], source, 'review', idea), undefined);

  // A ticket that merely says the same thing is not this suggestion taken up —
  // the row would go quiet claiming a ticket nobody made from it.
  assert.equal(madeInto([made(title, 'written by hand')], source, 'review', idea), undefined);
  assert.equal(madeInto([ticket], source, 'verify', idea), undefined);
  assert.equal(madeInto([ticket], { ...source, id: 't15' }, 'review', idea), undefined);
  assert.equal(madeInto([ticket], source, 'review', 'a different idea'), undefined);
});

test('the board is the order tickets were written, until you move one', () => {
  const written = ['t1', 't2', 't3', 't4'];

  assert.deepEqual(ordered(written, []), written);
  assert.deepEqual(ordered(written, [{ id: 't4', before: 't1' }]), ['t4', 't1', 't2', 't3']);
  assert.deepEqual(ordered(written, [{ id: 't1', before: null }]), ['t2', 't3', 't4', 't1']);

  // Moves apply in the order they were made, so the last word is the last one said.
  assert.deepEqual(
    ordered(written, [
      { id: 't4', before: 't1' },
      { id: 't4', before: 't3' },
    ]),
    ['t1', 't2', 't4', 't3'],
  );
});

test('a move that names a ticket no longer there falls to the end', () => {
  // Losing a card off the board because its neighbour left is the worse failure of
  // the two, and the only one you could not see had happened.
  assert.deepEqual(ordered(['t1', 't2'], [{ id: 't2', before: 't9' }]), ['t1', 't2']);
  assert.deepEqual(ordered(['t1', 't2'], [{ id: 't9', before: 't1' }]), ['t1', 't2']);
});

test('a ticket held behind another is not queued, and says who it waits for', () => {
  const policy = { wipLimit: 2, maxCycles: 3, maxTicketUsd: 50 };
  const waiting = { ...at('queued'), waitsFor: ['t2'] };
  const other = { ...at('implementing'), id: 't2' };

  assert.deepEqual(
    heldBy(waiting, [waiting, other]).map((h) => h.id),
    ['t2'],
  );
  // Not "queued": a slot coming free would do nothing for it, and saying so would
  // be a promise nothing keeps.
  assert.equal(waitingForSlot(waiting, 2, policy, true), false);
  assert.equal(waitingForSlot(waiting, 2, policy, false), true, 'and it is queued once let go');
});

test('a pull request lets go of what waits on it, and so does an ending', () => {
  const waiting = { ...at('queued'), waitsFor: ['t2'] };
  const held = (other: Ticket) => heldBy(waiting, [waiting, other]).map((h) => h.id);
  const other = (status: Status): Ticket => ({ ...at(status), id: 't2' });

  // The release is the pull request, not the merge: after it the branch is final,
  // and waiting for a person to merge would let a forgotten one stop the board.
  const offering = { ...other('awaiting_verdict'), prUrl: 'http://pr/1', offered: true };
  assert.deepEqual(held(offering), []);
  assert.deepEqual(held(other('verifying')), ['t2']);

  // A ticket sent back to be reworked keeps its pull request and is committing
  // again, so it has not let go — reading `prUrl` here let everything waiting on
  // it start while it was still moving.
  assert.deepEqual(held({ ...offering, status: 'implementing', offered: false }), ['t2']);

  // Nothing will ever pick these up, so nothing may be left waiting on them.
  for (const status of EVERY_STATUS) {
    const over = status === 'done' || status === 'cancelled' || status === 'gave_up';
    assert.equal(held(other(status)).length === 0, over, status);
  }

  // A ticket waiting on one that is not there waits for nothing.
  assert.deepEqual(heldBy(waiting, [waiting]), []);
  assert.deepEqual(heldBy(at('queued'), [at('queued')]), []);
});

/**
 * A dependency as its own events left it. Built from a history rather than from
 * `at`, which writes a status over a blank ticket and so leaves `offered` false
 * whatever it says: against that, a filter on the offer agrees with every answer
 * there is, including the wrong one.
 */
function dep(id: string, ...rest: EventBody[]): Ticket {
  const bodies: EventBody[] = [{ type: 'ticket_created', title: id, body: '' }, ...rest];
  return deriveTicket(
    bodies.map((body, i) => ({ ...body, id: i + 1, ticketId: id, at: `2026-08-05T0${i}` })),
  );
}

test('what a released ticket must be standing on is the work that is offered', () => {
  const waiting = { ...at('queued'), waitsFor: ['t2', 't3'] };
  const offered = (id: string): EventBody => ({ type: 'pr_opened', url: `http://pr/${id}` });
  const offering = (id: string): Ticket => dep(id, offered(id));
  const awaited = (...tickets: Ticket[]) => awaitedWork(waiting, tickets).map((t) => t.id);

  // Both, and in the order the manager named them: two dependencies offered at
  // once is the ordinary case, and neither may be dropped.
  assert.deepEqual(awaited(offering('t2'), offering('t3')), ['t2', 't3']);
  assert.deepEqual(awaited(offering('t3'), offering('t2')), ['t2', 't3']);

  // Released with nothing to take: nobody will finish these, and there is no branch
  // of theirs the waiting ticket should be built on. Their offer is still standing
  // — an ending does not take it back — so the offer alone would have taken work
  // the manager stopped and put it in the waiting ticket's pull request.
  const cancelled = dep('t2', offered('t2'), { type: 'cancelled', reason: 'not now' });
  const gaveUp = dep('t2', offered('t2'), { type: 'gave_up', reason: 'too dear' });
  assert.equal(cancelled.offered, true, 'which is why the ending is asked about too');
  assert.equal(gaveUp.offered, true);
  assert.deepEqual(awaited(cancelled, offering('t3')), ['t3']);
  assert.deepEqual(awaited(gaveUp, offering('t3')), ['t3']);

  // Merged: the work is in the base now, and the ordinary refresh brings it in.
  const merged = dep('t2', offered('t2'), { type: 'verdict', verdict: 'accepted' });
  assert.equal(merged.status, 'done');
  assert.deepEqual(awaited(merged, offering('t3')), ['t3']);

  // Still being built, so nothing is standing on it yet — `heldBy` is what stops
  // the ticket, and this says nothing about it either way. Both the one sent back
  // to be reworked, which is committing again on the branch it offered, and the one
  // that has never offered anything.
  const reworking = dep('t2', offered('t2'), { type: 'changes_requested', changes: 'the units' });
  assert.equal(reworking.status, 'implementing');
  assert.deepEqual(awaited(reworking, offering('t3')), ['t3']);
  assert.deepEqual(awaited(dep('t2'), offering('t3')), ['t3']);

  // A ticket that is not on the board contributes nothing, as it holds nothing.
  assert.deepEqual(awaited(offering('t3')), ['t3']);
  assert.deepEqual(awaitedWork(at('queued'), [at('queued')]), []);
});

test('a branch carries what it merged until that work reaches the base', () => {
  const offered = (id: string): EventBody => ({ type: 'pr_opened', url: `http://pr/${id}` });
  const took = { ...at('implementing'), carrying: ['wb/t2'] };

  // Taken once and taken again is one merge: a refresh that brings the base in
  // while the same dependency is still offered must not name it twice.
  assert.deepEqual(carriedWork(at('queued'), [], ['wb/t2']), ['wb/t2']);
  assert.deepEqual(carriedWork(took, [], ['wb/t2']), ['wb/t2']);
  assert.deepEqual(carriedWork(took, [], ['wb/t3']), ['wb/t2', 'wb/t3']);

  // Merged: the base has it now, so the branch is no longer standing on anything
  // the base has not got, and its own work can be measured from the base again.
  const merged = dep('t2', offered('t2'), { type: 'verdict', verdict: 'accepted' });
  assert.equal(merged.status, 'done');
  assert.deepEqual(carriedWork(took, [merged], []), []);

  // Everything else leaves the merge exactly where it is. Whatever the board says
  // about the dependency, the commit is in this branch and in no commit of the base
  // — this is a fact about the branch, and only a merge changes it.
  const reworking = dep('t2', offered('t2'), { type: 'changes_requested', changes: 'the units' });
  const rejected = dep('t2', offered('t2'), { type: 'verdict', verdict: 'rejected' });
  const cancelled = dep('t2', offered('t2'), { type: 'cancelled', reason: 'not now' });
  for (const other of [reworking, rejected, cancelled]) {
    assert.deepEqual(carriedWork(took, [other], []), ['wb/t2'], other.status);
  }
  assert.deepEqual(carriedWork(took, [], []), ['wb/t2'], 'and one not on the board at all');
});

test('a ticket the limit is holding back says so; nothing else does', () => {
  const policy = { wipLimit: 2, maxCycles: 3, maxTicketUsd: 50 };
  const held = at('implementing');

  // The case this exists for: plans approved together, more of them than may run.
  assert.equal(waitingForSlot(held, 2, policy), true);
  assert.equal(waitingForSlot(held, 1, policy), false, 'a free slot means it is starting');
  assert.equal(waitingForSlot({ ...held, running: true }, 2, policy), false, 'it is running');

  // Waiting on the manager is not waiting on a slot: emptying the board would not
  // start either of these, and saying "queued" would be a promise nothing keeps.
  assert.equal(waitingForSlot(at('plan_gate'), 2, policy), false);
  assert.equal(waitingForSlot(at('blocked', 'implement'), 2, policy), false);
  assert.equal(waitingForSlot(at('done'), 2, policy), false);
  assert.equal(waitingForSlot(at('backlog'), 2, policy), false);

  // Out of money is not queued either: a free slot buys it nothing.
  assert.equal(waitingForSlot({ ...held, costUsd: 50 }, 2, policy), false);
});

test('there is something to say no to once a ticket has started, and not before', () => {
  // The panel offered both noes at the plan gate and nowhere else, so work you
  // had already been offered could only be sent back through GitHub.
  const sendable = EVERY_STATUS.filter((s) => sendableBack(at(s)));
  assert.deepEqual(sendable, [
    'planning',
    'plan_gate',
    'implementing',
    'reviewing',
    'verifying',
    'ready_for_pr',
    'awaiting_verdict',
    'blocked',
  ]);

  // A run in flight still reports back, and its verdict would land on a ticket
  // that had already moved.
  assert.equal(sendableBack({ ...at('reviewing'), running: true }), false);
});

test('the chat reads back in order, with what each turn offered', () => {
  const rename = { action: 'edit', why: 'the title says nothing', title: 'Add a retry' };
  const chat = chatTurns(
    log(
      { type: 'ticket_created', title: 'x', body: '' },
      { type: 'chat_said', role: 'manager', text: 'what should this be called?' },
      {
        type: 'chat_said',
        role: 'agent',
        text: 'Something that says what it does.',
        proposals: [rename, { action: 'queue', why: 'it is ready' }],
        costUsd: 0.02,
        sessionId: 's1',
      },
      // Stage events are not chat, however much they look like a conversation.
      { type: 'agent_said', runId: 'r1', text: 'not part of the chat' },
    ),
  );

  assert.deepEqual(
    chat.turns.map((turn) => [turn.role, turn.text]),
    [
      ['manager', 'what should this be called?'],
      ['agent', 'Something that says what it does.'],
    ],
  );
  assert.deepEqual(chat.turns[0]?.proposals, []);
  // Counted across the whole conversation, which is how one is named to be accepted.
  assert.deepEqual(
    chat.turns[1]?.proposals.map((p) => [p.at, p.action, p.accepted]),
    [
      [0, 'edit', false],
      [1, 'queue', false],
    ],
  );
  assert.equal(chat.turns[1]?.costUsd, 0.02);
  assert.equal(chat.session, 's1');
});

test('a proposal that was taken up says so, and the rest do not', () => {
  const rename = { action: 'edit', why: 'the title says nothing', title: 'Add a retry' };
  const chat = chatTurns(
    log(
      {
        type: 'chat_said',
        role: 'agent',
        text: 'two ideas',
        proposals: [rename, { action: 'queue', why: 'ready' }],
      },
      { type: 'chat_accepted', proposal: rename },
    ),
  );

  assert.deepEqual(
    chat.turns[0]?.proposals.map((p) => p.accepted),
    [true, false],
  );
});

test('the chat has no session until the agent has said something', () => {
  const chat = chatTurns(log({ type: 'chat_said', role: 'manager', text: 'hello?' }));
  assert.equal(chat.session, null);
  // The last one wins: the next turn carries on from the most recent conversation.
  const later = chatTurns(
    log(
      { type: 'chat_said', role: 'agent', text: 'one', sessionId: 's1' },
      { type: 'chat_said', role: 'agent', text: 'two', sessionId: 's2' },
    ),
  );
  assert.equal(later.session, 's2');
});

test('what the chat said is shown without the blocks that became buttons', () => {
  // The manager reads this. A proposal is already on screen as the thing it offers
  // to do, and the JSON that made it is the same offer written for the workbench.
  const said = [
    'Two things.',
    '```wb-propose',
    '{"action": "queue", "why": "it is ready"}',
    '```',
    'The second can wait.',
    '```wb-propose',
    '{"action": "edit", "why": "the title says nothing", "title": "Add a retry"}',
    '```',
  ].join('\n\n');

  const shown = withoutProposals(said);
  assert.match(shown, /^Two things\./);
  assert.match(shown, /The second can wait\./);
  assert.doesNotMatch(shown, /wb-propose|"action"/);

  // A reply that proposed nothing is left exactly as it was written.
  assert.equal(withoutProposals('  I would leave it as it is.  '), 'I would leave it as it is.');
});

test('proposals are numbered across the whole conversation, not within a turn', () => {
  // This numbering is the only name a proposal has: the pane sends a position back
  // and the route acts on what is at it, so both read this one list.
  const events = log(
    { type: 'chat_said', role: 'agent', text: 'a', proposals: [{ action: 'queue', why: 'one' }] },
    { type: 'chat_said', role: 'manager', text: 'go on' },
    { type: 'chat_said', role: 'agent', text: 'b', proposals: [{ action: 'approve', why: 'two' }] },
  );

  assert.deepEqual(
    chatTurns(events).turns.flatMap((t) => t.proposals.map((p) => [p.at, p.why])),
    [
      [0, 'one'],
      [1, 'two'],
    ],
  );
});

test('merged work can be sent back to be tweaked, and nothing else can', () => {
  // The one status with no way back: a ticket that merged and then wanted a small
  // change could only be described again from scratch on a new ticket.
  assert.deepEqual(
    EVERY_STATUS.filter((s) => tweakable(at(s))),
    ['done'],
  );

  // The other two ended statuses are not this: there is nothing merged to tweak,
  // and what they offer is `salvageable` — a new ticket carrying on the branch.
  assert.equal(tweakable(at('cancelled')), false);
  assert.equal(tweakable(at('gave_up')), false);
});

test('anything that has not ended can be stopped, including an idea in the backlog', () => {
  // The panel offered no way out of the backlog at all, so an idea you decided
  // against stayed on the board for good — while `wb cancel` took it off all along.
  assert.equal(ended(at('backlog')), false);

  for (const status of EVERY_STATUS) {
    const over = status === 'done' || status === 'cancelled' || status === 'gave_up';
    assert.equal(ended(at(status)), over, status);
  }
});
