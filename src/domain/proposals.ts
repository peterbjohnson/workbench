import type { EventBody, Proposal } from './events.ts';
import type { Ticket } from './ticket.ts';

/**
 * What the chat agent may propose. Every one of them is something the manager could
 * already do from the panel, so accepting a proposal is a click that saves typing
 * rather than a power the chat has of its own.
 *
 * `ship`, `cancel` and `answer` are deliberately not here. The first two end a
 * ticket's life one way or the other and the third speaks for the manager to an
 * agent that is waiting — none of the three is a thing a conversation should be able
 * to offer as a button.
 */
export const CHAT_ACTIONS = ['edit', 'queue', 'backlog', 'approve', 'changes', 'reject'] as const;

/** The event a proposal is, or why it is not one. */
export type Proposed = { event: EventBody } | { refused: string };

/**
 * A proposal as the event accepting it appends — which is exactly the event the
 * equivalent button appends, and the same rules refuse it.
 *
 * Knows nothing about HTTP. The route that accepts a proposal has one job, which is
 * to append what this returns or to report what it refused.
 */
export function proposalEvent(ticket: Ticket, proposal: Proposal): Proposed {
  const said = proposal.text?.trim() ?? '';

  switch (proposal.action) {
    case 'edit': {
      const title = proposal.title === undefined ? undefined : proposal.title.trim();
      const body = proposal.body;
      if (title === '') return { refused: 'a ticket needs a title' };
      if (title === undefined && body === undefined) return { refused: 'nothing to change' };
      return { event: { type: 'ticket_edited', title, body } };
    }

    case 'queue':
      return { event: { type: 'queued' } };

    case 'backlog':
      return { event: { type: 'backlogged' } };

    case 'approve':
      return { event: { type: 'plan_approved' } };

    case 'changes': {
      if (said === '') return { refused: 'say what to put right' };
      // The same rule `/tickets/:id/changes` applies: no plan means the stage this
      // sends the ticket to has nothing to work from.
      if (ticket.plan === null) {
        return { refused: 'nothing has been planned yet — send it back instead' };
      }
      return { event: { type: 'changes_requested', changes: said } };
    }

    case 'reject': {
      if (said === '') return { refused: 'say why, so the next plan knows' };
      return { event: { type: 'plan_rejected', reason: said } };
    }

    default:
      return {
        refused: `the chat may not propose "${proposal.action}" — only ${CHAT_ACTIONS.join(', ')}`,
      };
  }
}
