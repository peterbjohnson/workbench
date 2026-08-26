import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatTurns,
  COLUMNS,
  columnFor,
  details,
  inColumn,
  madeInto,
  needsYou,
  ordered,
  proposalsMade,
  runs,
  sendableBack,
  statusOf,
  suggestion,
  toneOf,
  waitingForSlot,
  type Run,
} from './board.ts';
import type { Event, EventBody } from './events.ts';
import { heldBy } from './rules.ts';
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
        outcome: 'failed',
        summary: 'the workbench stopped while this stage was running',
      },
    ),
  );

  assert.equal(summarised.length, 1);
  assert.equal(summarised[0]?.stage, 'implement');
  assert.equal(summarised[0]?.outcome, 'failed');
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

test('proposals are numbered the same way at both ends', () => {
  const events = log(
    { type: 'chat_said', role: 'agent', text: 'a', proposals: [{ action: 'queue', why: 'one' }] },
    { type: 'chat_said', role: 'manager', text: 'go on' },
    { type: 'chat_said', role: 'agent', text: 'b', proposals: [{ action: 'approve', why: 'two' }] },
  );

  const made = proposalsMade(events);
  for (const turn of chatTurns(events).turns) {
    for (const offered of turn.proposals) assert.deepEqual(made[offered.at]?.why, offered.why);
  }
  assert.equal(made.length, 2);
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
