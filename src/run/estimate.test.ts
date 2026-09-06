import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createEstimator,
  estimateAsTicketsMove,
  pastTickets,
  readEstimate,
  type Estimator,
} from './estimate.ts';
import type { Asker } from './warmPool.ts';
import { CONFIG_FILE, loadConfig, type Config } from '../config.ts';
import type { Event, EventBody } from '../domain/events.ts';
import { deriveTicket } from '../domain/ticket.ts';
import { openStore } from '../store/store.ts';

/** A model service that never leaves the machine: one reply, or one failure. */
function service(reply: string | Error): { ask: Asker; prompts: string[] } {
  const prompts: string[] = [];

  const ask: Asker = async (prompt) => {
    prompts.push(prompt);
    if (reply instanceof Error) throw reply;
    return reply;
  };

  return { ask, prompts };
}

/** A throwaway home, with whatever the test wants in its config file. */
function scratchConfig(file: Record<string, unknown> = {}): Config {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-estimate-'));
  fs.writeFileSync(path.join(home, CONFIG_FILE), JSON.stringify(file));
  return loadConfig(home);
}

/** An event log with its times said out loud, which is what the two times read. */
function log(ticketId: string, entries: [string, EventBody][]): Event[] {
  return entries.map(([at, body], i) => ({ ...body, id: i + 1, ticketId, at }));
}

/** What `pastTickets` reads: some tickets, and the events each was derived from. */
function history(logs: Event[][]) {
  return {
    tickets: () => logs.map(deriveTicket),
    eventsFor: (id: string) => logs.find((one) => one[0]?.ticketId === id) ?? [],
  };
}

/** Nine to five and back again, twice, and accepted at lunchtime the next day. */
const FINISHED = log('t1', [
  ['2026-01-01T09:00:00Z', { type: 'ticket_created', title: 'a done thing', body: '' }],
  ['2026-01-01T09:00:00Z', { type: 'queued' }],
  ['2026-01-01T09:05:00Z', { type: 'stage_started', stage: 'plan', runId: 'r1' }],
  [
    '2026-01-01T09:15:00Z',
    {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'a plan',
      costUsd: 0.5,
      scale: 'small',
    },
  ],
  ['2026-01-01T09:20:00Z', { type: 'plan_approved' }],
  ['2026-01-01T10:00:00Z', { type: 'stage_started', stage: 'implement', runId: 'r2' }],
  [
    '2026-01-01T10:20:00Z',
    {
      type: 'stage_finished',
      runId: 'r2',
      outcome: 'completed',
      summary: 'built it',
      costUsd: 1.25,
    },
  ],
  ['2026-01-01T12:00:00Z', { type: 'verdict', verdict: 'accepted' }],
]);

/** The same ticket, still going. Nothing about it is history yet. */
const IN_FLIGHT = log('t2', [
  ['2026-01-01T09:00:00Z', { type: 'ticket_created', title: 'a live thing', body: 'details' }],
  ['2026-01-01T09:00:00Z', { type: 'queued' }],
  ['2026-01-01T09:05:00Z', { type: 'stage_started', stage: 'plan', runId: 'r1' }],
]);

/** An estimate is fired and not awaited, so let its promise chain run out. */
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((done) => setImmediate(done));
}

test('a reply in the two lines is an estimate', () => {
  assert.deepEqual(readEstimate('RANGE: 2-4 hours\nWHY: like the small ones\n'), {
    range: '2-4 hours',
    why: 'like the small ones',
  });
});

test('a reply that says neither offers nothing', () => {
  // Silence and rubbish are the same thing here: there is nothing to show, and
  // nothing that should be written down as though somebody had guessed.
  assert.equal(readEstimate(''), null);
  assert.equal(readEstimate('Hard to say without knowing more!'), null);
  assert.equal(readEstimate('WHY: there is nothing like it'), null);
});

test('the history is what finished tickets took, in minutes working and hours on the clock', () => {
  const past = pastTickets(history([FINISHED, IN_FLIGHT]));

  assert.equal(past.length, 1, 'a ticket still going has not taken anything yet');
  assert.deepEqual(past[0], {
    id: 't1',
    scale: 'small',
    cycles: 1,
    runs: 2,
    costUsd: 1.75,
    // Ten minutes planning and twenty building, out of the three hours the whole
    // thing was on the board. Both, because they answer different questions.
    runningMinutes: 30,
    elapsedHours: 3,
  });
});

test('the prompt is the setting verbatim, then the history, then the ticket', async () => {
  // Blank lines and all: this is a prompt, and paragraphs are part of what it says.
  const own = 'Guess how long.\n\nCompare it to what is below.';
  const config = scratchConfig({ estimatePrompt: own });
  const model = service('RANGE: 2-4 hours\nWHY: like t1');

  const estimate = await createEstimator(
    config,
    history([FINISHED, IN_FLIGHT]),
    model.ask,
  )(deriveTicket(IN_FLIGHT));

  assert.deepEqual(estimate, { range: '2-4 hours', why: 'like t1' });
  const asked = model.prompts[0] ?? '';
  assert.ok(asked.startsWith(own), 'what the setting says is what reaches the model');
  assert.match(asked, /t1 · small · 1 plans · 2 stage runs · \$1\.75 · 30 min working/);
  assert.match(asked, /3 hours from queued to over/);
  assert.match(asked, /Name: a live thing/, 'and then the ticket being asked about');
  assert.match(asked, /Instructions:\ndetails/);
  fs.rmSync(config.home, { recursive: true, force: true });
});

test('with no setting of its own the prompt that ships is what is asked', async () => {
  const config = scratchConfig();
  const model = service('RANGE: an hour\nWHY: nothing to go on');

  await createEstimator(config, history([]), model.ask)(deriveTicket(IN_FLIGHT));

  assert.match(model.prompts[0] ?? '', /RANGE: a span of time/, 'the shipped words reached it');
  assert.match(model.prompts[0] ?? '', /None yet\./, 'and a workbench with no history says so');
  fs.rmSync(config.home, { recursive: true, force: true });
});

test('a call that fails offers nothing, rather than failing', async () => {
  const config = scratchConfig();
  const model = service(new Error('the model service is down'));

  assert.equal(
    await createEstimator(config, history([FINISHED]), model.ask)(deriveTicket(IN_FLIGHT)),
    null,
  );
  fs.rmSync(config.home, { recursive: true, force: true });
});

test('a ticket is estimated when it is queued and after every stage it runs', async () => {
  const store = openStore(':memory:');
  const asked: string[] = [];
  const estimator: Estimator = async (t) => {
    asked.push(t.status);
    return { range: '2-4 hours', why: 'a guess' };
  };
  const stop = estimateAsTicketsMove(store, estimator);

  store.append('t1', { type: 'ticket_created', title: 'a thing', body: '' });
  await settled();
  assert.deepEqual(asked, [], 'writing a ticket down is not committing to it');

  store.append('t1', { type: 'queued' });
  await settled();
  assert.deepEqual(store.ticket('t1').estimate, { range: '2-4 hours', why: 'a guess' });

  store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
  await settled();
  assert.equal(asked.length, 1, 'a stage starting says nothing new about how long it takes');

  store.append('t1', {
    type: 'stage_finished',
    runId: 'r1',
    outcome: 'completed',
    summary: 'a plan',
  });
  await settled();
  assert.equal(asked.length, 2, 'a stage finishing does');
  assert.equal(asked[1], 'plan_gate', 'and it is asked about the ticket as it now is');

  // A ticket that is over is not going to take any longer, however late the run it
  // had in flight reports back.
  store.append('t1', { type: 'cancelled', reason: 'not wanted' });
  store.append('t1', {
    type: 'stage_finished',
    runId: 'r2',
    outcome: 'interrupted',
    summary: 'stopped',
  });
  await settled();
  assert.equal(asked.length, 2);

  stop();
  store.close();
});

test('a guess that comes to nothing writes no event and changes nothing', async () => {
  const store = openStore(':memory:');
  const stop = estimateAsTicketsMove(store, async () => null);

  store.append('t1', { type: 'ticket_created', title: 'a thing', body: 'details' });
  store.append('t1', { type: 'queued' });
  await settled();

  assert.equal(
    store.eventsFor('t1').some((e) => e.type === 'estimated'),
    false,
  );
  const t = store.ticket('t1');
  assert.equal(t.estimate, null);
  assert.equal(t.status, 'queued', 'and the ticket is exactly where it was');

  stop();
  store.close();
});
