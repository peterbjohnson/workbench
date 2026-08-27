import type { Ticket } from '../domain/ticket.ts';

/**
 * What `wb serve` says while it is stopping.
 *
 * Stopping already waits: nothing new starts, and every stage in flight is left to
 * finish. What it did not do was say so, and a wait with no account of itself is one
 * a person ends with a second Ctrl-C. That press is no longer the expensive one it
 * was: an abandoned stage keeps its conversation, and the board offers to carry it
 * on from where it got to. What it still costs is a stage left unfinished, and a
 * decision from whoever comes back to it.
 *
 * So the whole of this is telling someone what they are waiting for and what ending
 * it early would leave them holding. Its own module because the command line runs
 * itself on import, and a message worth testing should not need the process started
 * to read it.
 */

/** What is still in flight, and what waiting for it means. */
export function draining(running: readonly Ticket[]): string {
  if (running.length === 0) return 'nothing in flight. Stopping.';

  // Lined up, because this is read while waiting and a column of costs is the thing
  // being weighed. The widths come from the list rather than from the longest stage
  // name there could be: three plans stopping should not be indented past "implement".
  const id = width(running.map((t) => t.id));
  const stage = width(running.map((t) => t.stage ?? UNKNOWN));

  return [
    `finishing ${count(running)} before stopping. Nothing new will start.`,
    ...running.map(
      (t) =>
        `  ${t.id.padEnd(id)}  ${(t.stage ?? UNKNOWN).padEnd(stage)}  ${money(t.costUsd)} so far`,
    ),
    '',
    'Ctrl-C again to stop now — each keeps its conversation and can carry on from',
    'where it got to, but not until you pick it back up.',
  ].join('\n');
}

/** What was thrown away, said at the moment it is. */
export function abandoning(running: readonly Ticket[]): string {
  if (running.length === 0) return 'stopped.';

  const ids = running.map((t) => t.id).join(', ');
  return [
    `stopped, abandoning ${count(running)}: ${ids}.`,
    'Each will be waiting for you, and can carry on from where it got to.',
  ].join('\n');
}

/** What a stage is called when the ticket never recorded one. */
const UNKNOWN = 'a stage';

function width(values: string[]): number {
  return Math.max(...values.map((v) => v.length));
}

function count(running: readonly Ticket[]): string {
  return running.length === 1 ? '1 stage' : `${running.length} stages`;
}

/**
 * Whole dollars are not enough here: the number's job is to say what is at stake in
 * stopping now, and "$0" reads as nothing at stake when it is not nothing.
 */
function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
