import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, type Config } from '../config.ts';
import type { Event, Scale } from '../domain/events.ts';
import { ended, type Ticket } from '../domain/ticket.ts';
import type { Store } from '../store/store.ts';
import type { Asker } from './warmPool.ts';

/** How long a ticket is likely to take, and the one line saying what that is from. */
export type Estimate = { range: string; why: string };

/**
 * A guess at one ticket. Null is an ordinary answer and means there is nothing to
 * show — no history worth comparing to, a reply that said neither line, a model
 * service that was down. Nothing about a ticket depends on this, so nothing about
 * it may fail for want of it.
 */
export type Estimator = (ticket: Ticket) => Promise<Estimate | null>;

/**
 * What the model is asked, until someone edits it in the settings. Kept here rather
 * than in the settings file so there is one definition of it: the setting defaults
 * to this, and setting it back to this takes the key out of the config file again.
 */
export const DEFAULT_ESTIMATE_PROMPT = `Guess how long a ticket will take, from the tickets this workbench has already finished.

Each finished ticket is one line: what its plan judged the work to be worth, how many times it was planned, how many stage runs it took, what it cost, the minutes a stage was actually running, and the hours from being queued to being over — which include every night it sat waiting for a person.

Estimate the working time rather than the waiting, and compare like with like: what the work was judged to be worth is the strongest signal you have, and the ticket's own words are the next.

Answer with exactly two lines:

RANGE: a span of time, like "2-4 hours" or "1-2 days"
WHY: one short line saying what you compared it to

If there is not enough history to say anything useful, answer with nothing at all.`;

/**
 * One finished ticket, as crudely as it can be put and still be worth comparing to.
 * Both times, because they say different things: the hours include the nights a
 * ticket sat at the gate and the minutes do not, and the model is told the
 * difference rather than us picking one on its behalf.
 */
export type Past = {
  id: string;
  scale: Scale;
  /** How many times it was planned. */
  cycles: number;
  /** How many stage runs it took. */
  runs: number;
  costUsd: number;
  /** Minutes with a stage actually running, summed over the runs. */
  runningMinutes: number;
  /** Hours from being queued to its last event, waiting included. */
  elapsedHours: number;
};

/** What the history is read from. The store is one; a test's event log is another. */
type History = Pick<Store, 'tickets' | 'eventsFor'>;

/** Every ticket that is over, as a row. Ones still in flight have not taken anything yet. */
export function pastTickets(history: History): Past[] {
  return history
    .tickets()
    .filter(ended)
    .map((t) => {
      const events = history.eventsFor(t.id);
      return {
        id: t.id,
        scale: t.scale,
        cycles: t.cycles,
        runs: events.filter((e) => e.type === 'stage_started').length,
        costUsd: t.costUsd,
        ...times(events),
      };
    });
}

/** The two times, off the timestamps the events were appended with. */
function times(events: Event[]): { runningMinutes: number; elapsedHours: number } {
  const started = new Map<string, number>();
  let running = 0;
  for (const e of events) {
    if (e.type === 'stage_started') started.set(e.runId, Date.parse(e.at));
    if (e.type === 'stage_finished') {
      const from = started.get(e.runId);
      // A run nothing reported the start of contributes nothing, rather than
      // contributing every millisecond since 1970.
      if (from !== undefined) running += Date.parse(e.at) - from;
      started.delete(e.runId);
    }
  }

  const queued = events.find((e) => e.type === 'queued');
  const last = events[events.length - 1];
  const elapsed = queued && last ? Date.parse(last.at) - Date.parse(queued.at) : 0;

  return {
    runningMinutes: Math.round(running / 60_000),
    elapsedHours: Math.round(elapsed / 360_000) / 10,
  };
}

function row(p: Past): string {
  return [
    p.id,
    p.scale,
    `${p.cycles} plans`,
    `${p.runs} stage runs`,
    `$${p.costUsd.toFixed(2)}`,
    `${p.runningMinutes} min working`,
    `${p.elapsedHours} hours from queued to over`,
  ].join(' · ');
}

/** The setting's own words, then what has been done before, then this ticket. */
export function prompt(instructions: string, past: Past[], ticket: Ticket): string {
  return [
    instructions,
    '',
    '---',
    '',
    'Tickets this workbench has already finished:',
    '',
    past.length === 0 ? 'None yet.' : past.map(row).join('\n'),
    '',
    '---',
    '',
    'The ticket to estimate:',
    '',
    `Name: ${ticket.title}`,
    `Where it is: ${ticket.status.replace(/_/g, ' ')}`,
    `Judged to be worth: ${ticket.scale}`,
    `Times planned: ${ticket.cycles}`,
    ticket.steps.length === 0
      ? 'It has no steps yet.'
      : `Steps:\n${ticket.steps.map((step) => `- ${step}`).join('\n')}`,
    ticket.body.trim() === '' ? 'It has no instructions.' : `Instructions:\n${ticket.body.trim()}`,
  ].join('\n');
}

/**
 * The two lines a reply is, if it is one. Null for a reply that says neither —
 * silence and rubbish mean the same thing here, which is that there is nothing to
 * show and nothing to write down.
 */
export function readEstimate(reply: string): Estimate | null {
  let range = '';
  let why = '';

  for (const line of reply.split('\n')) {
    const said = /^RANGE:\s*(.+)$/i.exec(line.trim());
    if (said?.[1]) range = said[1].trim();
    const because = /^WHY:\s*(.+)$/i.exec(line.trim());
    if (because?.[1]) why = because[1].trim();
  }

  return range === '' ? null : { range, why };
}

export function createEstimator(config: Config, history: History, ask: Asker): Estimator {
  return async (ticket) => {
    try {
      return readEstimate(await ask(prompt(instructions(config), pastTickets(history), ticket)));
    } catch {
      return null;
    }
  };
}

/**
 * The prompt as this workbench has it. Read per call rather than held, because the
 * board edits this setting, and a guess made with the words from before an edit
 * looks exactly like an edit that did not save.
 */
function instructions(config: Config): string {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(config.home, CONFIG_FILE), 'utf8')) as {
      estimatePrompt?: string;
    };
    return file.estimatePrompt ?? DEFAULT_ESTIMATE_PROMPT;
  } catch {
    return DEFAULT_ESTIMATE_PROMPT;
  }
}

/**
 * Guess again whenever a ticket has moved: when the manager commits to it, and
 * after every stage it runs. Those are the moments something new is known about
 * it — a plan that judged the work, a stage that took what it took — and they are
 * moments nobody is watching, which is why the answer is written down rather than
 * asked for when the panel is opened.
 *
 * Returns an unsubscribe.
 */
export function estimateAsTicketsMove(store: Store, estimate: Estimator): () => void {
  return store.subscribe((e) => {
    if (e.type !== 'queued' && e.type !== 'stage_finished') return;
    const ticket = store.ticket(e.ticketId);
    // Including a late report on a ticket that has been stopped: it is not going
    // to take any longer.
    if (ended(ticket)) return;

    void estimate(ticket)
      .then((guess) => {
        if (guess !== null) store.append(e.ticketId, { type: 'estimated', ...guess });
      })
      // The workbench can be closed in the seconds a model call takes, and a guess
      // arriving after that has nowhere to go. Not worth bringing anything down.
      .catch(() => {});
  });
}
