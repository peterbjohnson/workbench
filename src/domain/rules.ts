import type { Stage } from './events.ts';
import { ended, type Ticket } from './ticket.ts';

export type Policy = {
  /** How many tickets may have a stage running at once. */
  wipLimit: number;
  /** How many times one ticket may be planned before the workbench stops paying. */
  maxCycles: number;
  /** What one ticket may cost, across every stage and every cycle. */
  maxTicketUsd: number;
};

export const DEFAULT_POLICY: Policy = { wipLimit: 2, maxCycles: 3, maxTicketUsd: 50 };

/**
 * Every limit there is, so the store persists them and the settings page offers
 * them by walking one list rather than by naming each one three times over.
 */
export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as (keyof Policy)[];

export type Action =
  | { kind: 'run_stage'; stage: Stage }
  | { kind: 'open_pr' }
  | { kind: 'poll_verdict' }
  /** The manager asked for the merge here rather than on the code host. */
  | { kind: 'merge_pr' }
  /** Stop the ticket: it has gone round too many times, or cost too much. */
  | { kind: 'give_up'; reason: string }
  /** Stop and ask the manager to decide. The work stands; the agents cannot agree. */
  | { kind: 'hand_over'; reason: string }
  /** Nothing to do: the manager's move, a run in flight, or no capacity. */
  | { kind: 'wait' };

const STAGE_FOR_STATUS = {
  planning: 'plan',
  implementing: 'implement',
  reviewing: 'review',
  verifying: 'verify',
} as const;

/**
 * Whether this ticket has let go of whatever is waiting on it.
 *
 * **A pull request is the release, not the merge.** What one ticket needs of
 * another is that it stop committing — after that its branch is final, and a
 * ticket that needs the code itself starts *from* that branch (`continues`) rather
 * than from a merge that has not happened. Waiting for the merge would make every
 * dependency wait on a person, and a forgotten pull request would stop the board.
 *
 * A ticket that ended — cancelled, given up on — releases too. Nothing else ever
 * will, and a queue held up by a ticket nobody is working on is the one failure
 * this must not have.
 *
 * `offered`, not `prUrl`. They meant the same thing until a ticket kept its pull
 * request through being sent back, and then they stopped: one being reworked has a
 * `prUrl` and is committing again, so reading that let everything waiting on it
 * start while it was still moving.
 */
export function released(t: Ticket): boolean {
  return t.offered || ended(t);
}

/**
 * The tickets this one is still waiting on. Empty when it waits on nothing, or
 * when everything it waits on has let go — it takes all of them, so the last one
 * to release is the one that starts the work.
 *
 * A named ticket that is not on the board is not waited for. Otherwise a typo, or
 * a board this was asked of before it had loaded, would hold a ticket for ever
 * against something that does not exist.
 */
export function heldBy(t: Ticket, tickets: readonly Ticket[]): Ticket[] {
  return t.waitsFor
    .map((id) => tickets.find((o) => o.id === id))
    .filter((o): o is Ticket => o !== undefined && !released(o));
}

/**
 * The only policy in the system. Pure: no I/O, no clock, no agent.
 *
 * @param running how many tickets have a stage in flight right now
 * @param held whether the ticket it waits for has not let go yet — `heldBy`, asked
 *   by the caller, which is the one that has the other tickets to hand
 */
export function nextAction(t: Ticket, running: number, p: Policy, held = false): Action {
  if (t.running) return { kind: 'wait' };

  switch (t.status) {
    case 'backlog': // an idea; the manager has not committed to it
    case 'blocked': // waiting on an answer
    case 'plan_gate': // waiting on approval
    case 'cancelled':
    case 'gave_up':
    case 'done':
      return { kind: 'wait' };

    case 'awaiting_verdict':
      // A merge asked for is an answer already given, so there is nothing to poll for.
      return t.mergeRequested ? { kind: 'merge_pr' } : { kind: 'poll_verdict' };

    case 'ready_for_pr':
      return { kind: 'open_pr' };

    case 'queued':
      return start(t, 'plan', running, p, held);

    case 'planning':
    case 'implementing':
    case 'reviewing':
    case 'verifying':
      return start(t, STAGE_FOR_STATUS[t.status], running, p, held);
  }
}

/**
 * The limits are checked here rather than at the point of spending, so nothing
 * starts that the policy would not pay for. Both apply to every stage, not just
 * the first.
 */
function start(t: Ticket, stage: Stage, running: number, p: Policy, held: boolean): Action {
  // Giving up needs no capacity, so it is decided before the work-in-progress limit.
  if (t.costUsd >= p.maxTicketUsd) {
    return {
      kind: 'give_up',
      reason: `spent $${t.costUsd.toFixed(2)}, which is the $${p.maxTicketUsd} a ticket may cost`,
    };
  }

  // Only a new plan is capped. A ticket on its last allowed cycle must be free to
  // finish that cycle — implement, review and verify are how it gets there.
  //
  // Reaching it is not the workbench being finished with the ticket; it is the
  // agents failing to agree, which is a thing for the manager to settle rather
  // than a reason to bin work. So it hands over instead of giving up: ship what is
  // there, guide it, or stop it. Every real ticket so far has died here.
  if (stage === 'plan' && t.cycles >= p.maxCycles) {
    return {
      kind: 'hand_over',
      reason:
        `planned ${t.cycles} times without review approving the result. ` +
        (t.rejection === null ? '' : `The last objection: ${t.rejection}\n\n`) +
        'Yours to settle: ship what is there, say what to do differently, or stop it.',
    };
  }

  // Checked after the limits and before the slot: a ticket that is out of money is
  // out of money whoever it is waiting for, and one that is waiting should not be
  // holding a slot open in the meantime.
  if (held) return { kind: 'wait' };

  return running < p.wipLimit ? { kind: 'run_stage', stage } : { kind: 'wait' };
}
