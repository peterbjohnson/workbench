import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyse, outcomeOf, prefixOf, stageRuns } from './analytics.ts';
import type { Event, EventBody } from './events.ts';
import { deriveTicket, type Ticket } from './ticket.ts';

/** An event list, stamped with ids and with a time for the ones that need one. */
function log(entries: [ticketId: string, body: EventBody, at?: string][]): Event[] {
  return entries.map(([ticketId, body, at], i) => ({
    ...body,
    id: i + 1,
    ticketId,
    at: at ?? '2026-01-05T00:00:00.000Z',
  }));
}

/** The tickets those events derive to, which is what the store would hand `analyse`. */
function tickets(events: readonly Event[]): Ticket[] {
  const ids = [...new Set(events.map((e) => e.ticketId))];
  return ids.map((id) => deriveTicket(events.filter((e) => e.ticketId === id)));
}

const made = (title: string): EventBody => ({ type: 'ticket_created', title, body: '' });

test('an outcome is what became of the ticket, not where it is', () => {
  const done = deriveTicket(log([['t1', made('x')]]));
  assert.equal(outcomeOf({ ...done, status: 'done' }), 'accepted');
  assert.equal(outcomeOf({ ...done, status: 'cancelled' }), 'cancelled');
  assert.equal(outcomeOf({ ...done, status: 'gave_up' }), 'gave_up');
  assert.equal(outcomeOf({ ...done, status: 'implementing' }), 'open');
  assert.equal(outcomeOf({ ...done, status: 'backlog' }), 'open');
});

test('a prefix is the word a title is written behind, lowercased', () => {
  assert.equal(prefixOf('feature: Add analytics'), 'feature');
  assert.equal(prefixOf('Fix: the thing'), 'fix');
  assert.equal(prefixOf('chore-ish: whatever'), 'chore-ish');
  assert.equal(prefixOf('no prefix here'), null);
  assert.equal(prefixOf('http://example.com is not one'), null);
});

test('a stage run is a start paired with the finish on the same ticket', () => {
  const runs = stageRuns(
    log([
      ['t1', { type: 'stage_started', stage: 'plan', runId: 'r1' }, '2026-01-05T00:00:00.000Z'],
      [
        't1',
        { type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: '', costUsd: 0.25 },
        '2026-01-05T00:02:00.000Z',
      ],
    ]),
  );

  assert.deepEqual(runs, [
    { ticketId: 't1', stage: 'plan', outcome: 'completed', costUsd: 0.25, ms: 120_000 },
  ]);
});

test('two tickets running at once do not close each other', () => {
  const runs = stageRuns(
    log([
      ['t1', { type: 'stage_started', stage: 'plan', runId: 'a' }, '2026-01-05T00:00:00.000Z'],
      ['t2', { type: 'stage_started', stage: 'review', runId: 'b' }, '2026-01-05T00:00:00.000Z'],
      [
        't2',
        { type: 'stage_finished', runId: 'b', outcome: 'failed', summary: '' },
        '2026-01-05T00:01:00.000Z',
      ],
      [
        't1',
        { type: 'stage_finished', runId: 'a', outcome: 'completed', summary: '' },
        '2026-01-05T00:03:00.000Z',
      ],
    ]),
  );

  assert.deepEqual(
    runs.map((r) => [r.ticketId, r.stage, r.outcome, r.ms]),
    [
      ['t1', 'plan', 'completed', 180_000],
      ['t2', 'review', 'failed', 60_000],
    ],
  );
});

test('a run that never finished has no outcome and no duration', () => {
  const [run] = stageRuns(log([['t1', { type: 'stage_started', stage: 'verify', runId: 'r1' }]]));
  assert.equal(run?.outcome, null);
  assert.equal(run?.ms, null);
});

test('a finish written by reconcile still closes its run', () => {
  // `reconcile` closes an abandoned run under the id `interrupted`, not the run's
  // own id — so pairing on `runId` would leave every killed stage looking open.
  const [run] = stageRuns(
    log([
      ['t1', { type: 'stage_started', stage: 'implement', runId: 'r1' }],
      ['t1', { type: 'stage_finished', runId: 'interrupted', outcome: 'interrupted', summary: '' }],
    ]),
  );
  assert.equal(run?.outcome, 'interrupted');
});

test('an empty log gives zeroes rather than NaN', () => {
  const a = analyse([], []);
  assert.equal(a.headline.tickets, 0);
  assert.equal(a.headline.acceptanceRate, 0);
  assert.equal(a.headline.meanAcceptedUsd, 0);
  assert.equal(a.headline.medianAcceptedUsd, 0);
  assert.equal(a.headline.dearest, null);
  assert.equal(a.flow.medianLeadMs, null);
  assert.equal(a.flow.meanCycles, 0);
  assert.deepEqual(a.flow.perWeek, []);
  assert.deepEqual(a.money.dearest, []);
  assert.equal(a.agents.toolCalls, 0);
});

/** One ticket taken all the way through, which most of the numbers are read off. */
const ACCEPTED: [string, EventBody, string?][] = [
  ['t1', made('feature: a thing'), '2026-01-05T09:00:00.000Z'],
  ['t1', { type: 'queued' }, '2026-01-05T10:00:00.000Z'],
  ['t1', { type: 'stage_started', stage: 'plan', runId: 'r1' }, '2026-01-05T11:00:00.000Z'],
  [
    't1',
    {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'planned',
      costUsd: 1,
      scale: 'small',
    },
    '2026-01-05T11:30:00.000Z',
  ],
  ['t1', { type: 'plan_approved' }, '2026-01-05T11:40:00.000Z'],
  ['t1', { type: 'stage_started', stage: 'implement', runId: 'r2' }, '2026-01-05T12:00:00.000Z'],
  ['t1', { type: 'tool_requested', runId: 'r2', tool: 'Edit', input: {}, allowed: true }],
  ['t1', { type: 'tool_requested', runId: 'r2', tool: 'Edit', input: {}, allowed: true }],
  ['t1', { type: 'tool_requested', runId: 'r2', tool: 'Bash', input: {}, allowed: false }],
  [
    't1',
    {
      type: 'stage_finished',
      runId: 'r2',
      outcome: 'completed',
      summary: '',
      costUsd: 3,
      commit: 'c1',
    },
    '2026-01-05T13:00:00.000Z',
  ],
  ['t1', { type: 'chat_said', role: 'agent', text: 'hello', costUsd: 0.5 }],
  ['t1', { type: 'verdict', verdict: 'accepted' }, '2026-01-05T14:00:00.000Z'],
];

test('the headline counts the board and what it has cost', () => {
  const events = log([
    ...ACCEPTED,
    ['t2', made('fix: another'), '2026-01-06T09:00:00.000Z'],
    ['t2', { type: 'cancelled', reason: 'no' }, '2026-01-06T10:00:00.000Z'],
  ]);
  const { headline } = analyse(tickets(events), events);

  assert.equal(headline.tickets, 2);
  assert.equal(headline.accepted, 1);
  assert.equal(headline.cancelled, 1);
  assert.equal(headline.gaveUp, 0);
  assert.equal(headline.acceptanceRate, 0.5);
  // The stages, and only the stages: chat is recorded apart so that talking about
  // a ticket cannot push it past its limit.
  assert.equal(headline.totalUsd, 4);
  assert.equal(headline.chatUsd, 0.5);
  assert.equal(headline.medianAcceptedUsd, 4);
  assert.deepEqual(headline.dearest, { id: 't1', title: 'feature: a thing', costUsd: 4 });
  assert.deepEqual(
    headline.byColumn.find((s) => s.label === 'Done'),
    { label: 'Done', value: 2 },
  );
});

test('money is split by the stage that spent it and the scale it was judged at', () => {
  const events = log(ACCEPTED);
  const { money } = analyse(tickets(events), events);

  assert.deepEqual(money.byStage, [
    { label: 'plan', value: 1 },
    { label: 'implement', value: 3 },
    { label: 'review', value: 0 },
    { label: 'verify', value: 0 },
  ]);
  assert.deepEqual(money.byScale, [
    { label: 'small', value: 4 },
    { label: 'standard', value: 0 },
    { label: 'large', value: 0 },
  ]);
  assert.deepEqual(money.dearest, [{ id: 't1', title: 'feature: a thing', costUsd: 4 }]);
  // $4 falls in the $2–5 bucket, and a ticket that spent nothing is in none of them.
  assert.deepEqual(
    money.histogram.map((s) => s.value),
    [0, 0, 0, 1, 0, 0],
  );
});

test('flow measures both spans, and the two of them differ by the wait for a slot', () => {
  const events = log(ACCEPTED);
  const { flow } = analyse(tickets(events), events);

  assert.equal(flow.medianLeadMs, 4 * 60 * 60 * 1000, 'queued 10:00 to accepted 14:00');
  assert.equal(flow.medianBuildMs, 3 * 60 * 60 * 1000, 'first stage 11:00 to accepted 14:00');
  assert.equal(flow.approvals, 1);
  assert.equal(flow.rejections, 0);
  assert.equal(flow.meanCycles, 1);
  assert.equal(flow.meanCommits, 1);
});

test('the weekly count runs back twelve weeks from the last thing that ended', () => {
  const events = log([
    ...ACCEPTED,
    ['t2', made('two'), '2026-01-05T09:00:00.000Z'],
    ['t2', { type: 'gave_up', reason: 'too much' }, '2026-01-08T09:00:00.000Z'],
    ['t3', made('three'), '2026-01-05T09:00:00.000Z'],
    ['t3', { type: 'cancelled', reason: 'no' }, '2026-01-15T09:00:00.000Z'],
  ]);
  const { perWeek } = analyse(tickets(events), events).flow;

  assert.equal(perWeek.length, 12);
  // 5 and 8 January are the same Monday-to-Sunday week; 15 January is the next.
  assert.deepEqual(perWeek.slice(-2), [
    { label: '5 Jan', value: 2 },
    { label: '12 Jan', value: 1 },
  ]);
});

test('a median over an even count is the middle two averaged', () => {
  // Four accepted tickets costing 1, 2, 3 and 4: the median is 2.5, the mean 2.5.
  const events = log(
    [1, 2, 3, 4].flatMap((n): [string, EventBody, string?][] => [
      [`t${n}`, made(`t${n}`)],
      [`t${n}`, { type: 'stage_started', stage: 'plan', runId: `r${n}` }],
      [
        `t${n}`,
        { type: 'stage_finished', runId: `r${n}`, outcome: 'completed', summary: '', costUsd: n },
      ],
      [`t${n}`, { type: 'verdict', verdict: 'accepted' }],
    ]),
  );
  const { headline } = analyse(tickets(events), events);

  assert.equal(headline.medianAcceptedUsd, 2.5);
  assert.equal(headline.meanAcceptedUsd, 2.5);
});

test('the agent section counts runs, questions, tools and checks', () => {
  const events = log([
    ...ACCEPTED,
    ['t1', { type: 'stage_started', stage: 'review', runId: 'r3' }, '2026-01-05T15:00:00.000Z'],
    ['t1', { type: 'question_asked', runId: 'r3', question: 'which?', reasoning: '' }],
    [
      't1',
      {
        type: 'checks_run',
        runId: 'r3',
        results: [
          { command: 'npm test', ok: true, output: '' },
          { command: 'npm run lint', ok: false, output: '' },
        ],
      },
    ],
    [
      't1',
      { type: 'stage_finished', runId: 'r3', outcome: 'blocked', summary: '' },
      '2026-01-05T15:10:00.000Z',
    ],
  ]);
  const { agents } = analyse(tickets(events), events);

  assert.equal(agents.toolCalls, 3);
  assert.equal(agents.refused, 1);
  assert.deepEqual(agents.tools, [
    { label: 'Edit', value: 2 },
    { label: 'Bash', value: 1 },
  ]);
  assert.deepEqual(agents.checks, { passed: 1, failed: 1 });
  assert.deepEqual(
    agents.questions.filter((s) => s.value > 0),
    [{ label: 'review', value: 1 }],
  );

  const implement = agents.stages.find((s) => s.stage === 'implement');
  assert.equal(implement?.runs, 1);
  assert.equal(implement?.medianMs, 60 * 60 * 1000);
  assert.equal(implement?.meanUsd, 3);
  assert.deepEqual(agents.stages.find((s) => s.stage === 'review')?.outcomes, [
    { label: 'blocked', value: 1 },
  ]);
});

test('a run still going counts as a run but is in neither stage average', () => {
  // One finished implement run costing $3, and a second one started and still open:
  // the stage has cost $3 a run so far, and the mean must not say $1.50.
  const events = log([
    ['t1', made('a thing'), '2026-01-05T09:00:00.000Z'],
    ['t1', { type: 'stage_started', stage: 'implement', runId: 'r1' }, '2026-01-05T10:00:00.000Z'],
    [
      't1',
      { type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: '', costUsd: 3 },
      '2026-01-05T11:00:00.000Z',
    ],
    ['t1', { type: 'stage_started', stage: 'implement', runId: 'r2' }, '2026-01-05T12:00:00.000Z'],
  ]);
  const { agents } = analyse(tickets(events), events);

  const implement = agents.stages.find((s) => s.stage === 'implement');
  assert.equal(implement?.runs, 2);
  assert.equal(implement?.medianMs, 60 * 60 * 1000);
  assert.equal(implement?.meanUsd, 3);
  assert.deepEqual(implement?.outcomes, [
    { label: 'completed', value: 1 },
    { label: 'running', value: 1 },
  ]);
});
