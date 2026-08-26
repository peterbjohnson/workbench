import type { Event, Scale, Stage } from './events.ts';

export type Status =
  /** An idea, and nothing more. The workbench never touches a ticket here. */
  | 'backlog'
  | 'queued'
  | 'planning'
  | 'plan_gate'
  | 'implementing'
  | 'reviewing'
  | 'verifying'
  | 'ready_for_pr'
  | 'awaiting_verdict'
  | 'blocked'
  | 'cancelled'
  | 'gave_up'
  | 'done';

export type Ticket = {
  id: string;
  title: string;
  body: string;
  /** Where the ticket is. The board column. */
  status: Status;
  /** The stage last started. Kept while blocked so we know what to resume. */
  stage: Stage | null;
  /** True while a stage run is in flight. */
  running: boolean;
  /** wb/<id>. The worktree path is derived from this outside the domain. */
  branch: string;
  /** The ticket this one carries on from, and whose branch it started on. */
  continues: string | null;
  /**
   * Tickets this one must not start ahead of. Nothing runs while any of them is
   * unmet — see `heldBy`, which says what meeting one takes and is the only thing
   * that reads this.
   *
   * Not the same as `continues`, and they compose: that one says where the work
   * *starts from* and is fixed when the branch is cut; these say *when*, and can
   * be set and taken off at any time.
   */
  waitsFor: string[];
  /**
   * Whether a finished plan stops for the manager. Decided when the ticket is
   * written and true unless it says otherwise: the gate is the one place a person
   * sees the work before any money is spent building it, and skipping it is a
   * thing to choose rather than a thing to forget.
   *
   * It moves the gate, and nothing else. The plan is still written, still recorded
   * and still what review and verify judge against.
   */
  requiresApproval: boolean;
  /** Summary of the last plan run. This is what the gate shows the manager. */
  plan: string | null;
  /**
   * How much the plan judged the work to warrant. Shown at the gate, so approving
   * the plan approves its self-assessment too. Every stage still runs whatever it
   * says; only the depth asked of them changes.
   */
  scale: Scale;
  /**
   * What the plan said the work breaks into, in order. Shown at the gate, so the
   * manager approves the steps along with the plan, and used afterwards as the
   * thing progress is reported against.
   */
  steps: string[];
  /**
   * What the plan said would make this ticket finished, agreed at the gate. The
   * only thing review and verify are entitled to judge against — without it they
   * are answering "is this as good as it could be", which has no end, and which
   * is what killed the first two real tickets.
   */
  doneWhen: string[];
  /**
   * The step the running stage says it has reached, counting from 1. Null when a
   * stage has not said, which is every stage that does not announce them.
   */
  step: number | null;
  /** Why the ticket came back to planning. Fed into the next plan. */
  rejection: string | null;
  /**
   * What review or verify asked to be put right, when the approach was sound.
   * Fed into the implement stage that addresses it, and cleared when it starts.
   */
  changes: string | null;
  /**
   * How many times this plan's work has gone back to implement to be fixed. One
   * per round of comments; reset by a new plan, which is a new approach.
   */
  revisions: number;
  /** Set while an agent is waiting on the manager. */
  question: { question: string; reasoning: string } | null;
  /**
   * The conversation a stage stopped mid-way, so answering it can carry on rather
   * than pay again for thinking already done. Null unless something is parked.
   */
  session: string | null;
  /** The manager's reply, carried into the resumed run and cleared once it starts. */
  answer: string | null;
  /**
   * The pull request this ticket's work went to. Set when it is first opened and
   * never cleared: the branch keeps its pull request, so a ticket being reworked
   * is still headed for that one, and the link is worth most exactly then — it is
   * where the objection being answered was written.
   */
  prUrl: string | null;
  /**
   * Whether an offer is standing and waiting on the manager. Not the same as
   * having a `prUrl`, which a ticket keeps for ever once it has one: this is true
   * only between offering the work and hearing back about it.
   *
   * It cannot be read off the status, which is what it otherwise would be:
   * `blocked` replaces the status, so a ticket that got stuck while an offer stood
   * has nowhere else to record that it did. Two things need to know — shipping
   * again would be offering what is already offered, and restarting a stage means
   * something different when the stages are finished.
   */
  offered: boolean;
  /**
   * What this ticket's change is measured against: the commit the branch was cut
   * from, and afterwards the last base it merged in. Not a record of where it
   * started — that is in the events — but the point a diff of its own work is
   * taken from.
   */
  base: string | null;
  /** Every commit this ticket has made, oldest first. */
  commits: string[];
  /** How many times this ticket has been planned. One per trip round the loop. */
  cycles: number;
  /** What the ticket has cost so far, summed over every stage run. */
  costUsd: number;
};

const STATUS_FOR_STAGE: Record<Stage, Status> = {
  plan: 'planning',
  implement: 'implementing',
  review: 'reviewing',
  verify: 'verifying',
};

/**
 * How many rounds of comments one plan's work may go through before the
 * disagreement is treated as being about the approach rather than the execution,
 * and the ticket is re-planned.
 *
 * A rule rather than a spend limit: `maxCycles` and `maxTicketUsd` say what the
 * manager will pay for, this says what a repeated objection means. Two loops that
 * each terminate, instead of one that can run for ever.
 */
export const MAX_REVISIONS = 2;

/** The stage that follows a completed, approved one. Null means the loop is over. */
const NEXT_STAGE: Record<Stage, Stage | null> = {
  plan: null, // gated: the manager decides
  implement: 'review',
  review: 'verify',
  verify: null, // straight to a pull request
};

function blank(id: string): Ticket {
  return {
    id,
    title: '',
    body: '',
    // Writing a ticket down is not deciding to do it. Nothing starts until the
    // manager moves it to the queue.
    status: 'backlog',
    stage: null,
    running: false,
    branch: `wb/${id}`,
    continues: null,
    waitsFor: [],
    requiresApproval: true,
    plan: null,
    scale: 'standard',
    steps: [],
    doneWhen: [],
    step: null,
    rejection: null,
    changes: null,
    revisions: 0,
    question: null,
    session: null,
    answer: null,
    prUrl: null,
    offered: false,
    base: null,
    commits: [],
    cycles: 0,
    costUsd: 0,
  };
}

/** Pure. No I/O, no clock. */
export function applyEvent(t: Ticket, e: Event): Ticket {
  switch (e.type) {
    case 'ticket_created':
      return {
        ...blank(e.ticketId),
        title: e.title,
        body: e.body,
        continues: e.continues ?? null,
        requiresApproval: e.requiresApproval ?? true,
      };

    case 'ticket_edited':
      return { ...t, title: e.title ?? t.title, body: e.body ?? t.body };

    // The two moves the manager makes by hand, and the only two. Each is ignored
    // unless the ticket is in the state the other one leaves it in, so neither can
    // reach in and pull a ticket out of work that has already started.
    case 'queued':
      return t.status === 'backlog' ? { ...t, status: 'queued' } : t;

    case 'backlogged':
      return t.status === 'queued' ? { ...t, status: 'backlog' } : t;

    case 'waits_for':
      return { ...t, waitsFor: e.tickets };

    // Where a ticket sits is a fact about the board, not about the ticket: it is
    // read back across every ticket's events at once, in `ordered`.
    case 'moved':
      return t;

    /**
     * Nothing to offer without commits, and nothing to do for work already
     * accepted or already offered. Not while a stage is running either: that run
     * still reports back, and `afterStage` would route the ticket straight out of
     * `ready_for_pr` again. Anywhere else — blocked, given up on, waiting after a
     * rejection — it goes.
     *
     * Read from `offered` rather than from `prUrl`: a ticket sent back to be
     * reworked keeps the pull request it is headed for, and shipping is exactly
     * what you want to be able to do to it.
     */
    case 'shipped':
      return t.running || t.commits.length === 0 || t.status === 'done' || t.offered
        ? t
        : { ...t, status: 'ready_for_pr', question: null };

    // Put a stuck ticket back into the stage it stopped in, with nothing carried
    // over: a run that died has no conversation worth resuming and no answer to
    // read. Guarded like the two above, so it cannot reach in and restart work
    // that is already going.
    case 'stage_restarted': {
      if (t.status !== 'blocked') return t;
      const resumed = { ...t, question: null, answer: null, session: null };

      // Unless an offer is standing, in which case there is no stage to put it back
      // into: the last one finished before the pull request was opened, and what
      // stalled is the wait for a verdict. Going round the stages again would
      // arrive at `ready_for_pr` for a branch that already has a pull request — how
      // t32 blocked itself twice on `gh pr create` with the work complete all along.
      //
      // `offered`, not `prUrl`: a ticket sent back to be reworked still has its
      // pull request, and a stage that fails during that rework must restart as a
      // stage rather than dropping it back into a wait that is already over.
      if (t.offered) return { ...resumed, status: 'awaiting_verdict' };

      return t.stage === null ? t : { ...resumed, status: STATUS_FOR_STAGE[t.stage] };
    }

    case 'stage_started':
      return {
        ...t,
        stage: e.stage,
        status: STATUS_FOR_STAGE[e.stage],
        running: true,
        question: null,
        answer: null,
        // A plan is what starts a trip round the loop, so it is what counts one.
        cycles: e.stage === 'plan' ? t.cycles + 1 : t.cycles,
        // A new plan re-judges the size of the work from nothing. Carrying the last
        // one's verdict forward would let a stale "small" quietly outlive the plan
        // that justified it. Its steps go the same way, for the same reason.
        scale: e.stage === 'plan' ? 'standard' : t.scale,
        steps: e.stage === 'plan' ? [] : t.steps,
        doneWhen: e.stage === 'plan' ? [] : t.doneWhen,
        // A new plan is a new approach, so the rounds of comments start again.
        revisions: e.stage === 'plan' ? 0 : t.revisions,
        // Read into the brief by the stage now starting; it must not be read twice.
        changes: null,
        // Progress belongs to a run, not to the ticket. A stage starting has made none.
        step: null,
      };

    case 'step_reached':
      return { ...t, step: e.index };

    case 'agent_said':
    case 'tool_requested':
    case 'checks_run':
      return t; // record only; the board reads these

    case 'question_asked':
      return { ...t, question: { question: e.question, reasoning: e.reasoning } };

    case 'question_answered': {
      const answered = { ...t, question: null, running: false };

      // An offer standing means the stages are over: what stopped was the wait for
      // a verdict, and there is no stage to put the ticket back into. t61 paid for
      // verify twice this way — the poll failed, answering it re-ran the stage that
      // had already passed, and only then did it come back to the wait it never
      // left. `stage_restarted` reads `offered` for the same reason.
      //
      // The answer goes nowhere, because there is nothing to say it to. Keeping it
      // would be worse than dropping it: the next stage to run is the one after a
      // rejection, and it would open with a reply to a question about something
      // else entirely.
      if (t.offered) return { ...answered, status: 'awaiting_verdict' };

      // Resume the stage that stopped. Nothing is redone from scratch.
      return {
        ...answered,
        answer: e.answer,
        status: t.stage ? STATUS_FOR_STAGE[t.stage] : 'queued',
      };
    }

    case 'branched':
      return { ...t, branch: e.branch, base: e.base };

    // The merge commit is the ticket's, and the new base is what its change is now
    // measured against — `diff` reads `base...HEAD`, so leaving the old one there
    // would show a reviewer everything the base gained as though the ticket had
    // written it.
    //
    // Except for a ticket carrying on from another: its base is that ticket's
    // branch, and moving it to the base proper is the same mistake the other way
    // round — the earlier ticket's work would read as this one's.
    case 'refreshed':
      return {
        ...t,
        base: t.continues === null ? e.base : t.base,
        commits: [...t.commits, e.commit],
      };

    // Record only, unlike `refreshed`: there is no commit and the base has not
    // moved. The merge is on disk, and the stage now running is what finishes it.
    case 'conflicted':
      return t;

    case 'stage_finished': {
      // The spend counts whatever the outcome: a failed run still cost money, and
      // a commit it left behind is part of the ticket's record either way.
      const recorded = {
        ...t,
        costUsd: t.costUsd + (e.costUsd ?? 0),
        // Named twice for one commit when the stage finished a merge it was handed:
        // by the `refreshed` that moves the base, and here by the stage that made it.
        commits:
          e.commit !== undefined && !t.commits.includes(e.commit)
            ? [...t.commits, e.commit]
            : t.commits,
        scale: e.scale ?? t.scale,
        steps: e.steps ?? t.steps,
        doneWhen: e.doneWhen ?? t.doneWhen,
        // Set only by a run that stopped with something left to say; anything else
        // clears it, so nothing ever resumes a conversation that has finished.
        session: e.sessionId ?? null,
      };
      return afterStage(recorded, e);
    }

    case 'plan_approved':
      return { ...t, status: 'implementing', running: false, rejection: null };

    // The manager's two ways of saying no, and the only difference between them is
    // what they cost: this one buys a new plan, the next one keeps the work.
    // Either ends the offer without touching `prUrl` — the branch keeps its pull
    // request, and the rework is pushed to that same one.
    case 'plan_rejected':
      return { ...t, status: 'planning', running: false, offered: false, rejection: e.reason };

    // Not capped, and no revision counted: see `changes_requested` in events.ts.
    case 'changes_requested':
      return { ...t, status: 'implementing', running: false, offered: false, changes: e.changes };

    case 'pr_opened':
      return { ...t, status: 'awaiting_verdict', prUrl: e.url, offered: true };

    case 'blocked':
      return {
        ...t,
        status: 'blocked',
        running: false,
        question: {
          question: e.reason,
          reasoning: 'the workbench could not carry on by itself',
        },
      };

    // Both are the end of the road. Nothing resumes them, so nothing is kept for a
    // resumed run; the reason is in the event log, which is where the board reads it.
    case 'cancelled':
      return { ...t, status: 'cancelled', running: false, question: null };

    case 'gave_up':
      return { ...t, status: 'gave_up', running: false, question: null };

    // A rejection ends the offer as well as the round: the reworked ticket is
    // offered again, on the same branch and so on the same pull request — which is
    // why `prUrl` stays. It is `offered` that ends, so the ticket can be shipped
    // and its stages restarted while it is being put right.
    case 'verdict':
      return e.verdict === 'accepted'
        ? { ...t, status: 'done', offered: false }
        : { ...t, status: 'planning', offered: false, rejection: e.reason ?? null };
  }
}

function afterStage(t: Ticket, e: Extract<Event, { type: 'stage_finished' }>): Ticket {
  const stopped = { ...t, running: false };

  // A stopped ticket still hears back from the run it had in flight. It has already
  // ended; the late report must not resurrect it as blocked.
  if (t.status === 'cancelled' || t.status === 'gave_up') return stopped;

  // A crash is not a rejection. It parks and waits for the manager, same as a question.
  if (e.outcome === 'blocked' || e.outcome === 'failed') {
    return { ...stopped, status: 'blocked' };
  }

  if (e.rejected !== undefined) {
    return { ...stopped, status: 'planning', rejection: e.rejected };
  }

  // Comments on work whose approach is sound: back to the stage that made it,
  // carrying what to put right. Only so many times — an objection that survives
  // being addressed twice is evidence about the approach, not the execution, and
  // that is a matter for a new plan.
  if (e.changes !== undefined) {
    return t.revisions + 1 > MAX_REVISIONS
      ? {
          ...stopped,
          status: 'planning',
          rejection: `after ${t.revisions} attempts to address it: ${e.changes}`,
        }
      : {
          ...stopped,
          status: 'implementing',
          changes: e.changes,
          revisions: t.revisions + 1,
        };
  }

  const stage = t.stage;
  if (stage === null) return stopped;

  // The one place the gate is a gate. A ticket written without one goes straight
  // on to build what it just planned — the plan is still written and still what
  // the later stages are held to; nobody is asked to agree it first.
  if (stage === 'plan') {
    const planned = { ...stopped, plan: e.summary };
    return t.requiresApproval
      ? { ...planned, status: 'plan_gate' }
      : { ...planned, status: 'implementing' };
  }
  if (stage === 'verify') {
    return { ...stopped, status: 'ready_for_pr' };
  }

  const next = NEXT_STAGE[stage];
  return next ? { ...stopped, status: STATUS_FOR_STAGE[next] } : stopped;
}

/**
 * A ticket that is over. Nothing further happens to one of these, and everything
 * else can still be stopped — including one sitting in the backlog, which the
 * panel used to offer no way out of at all: an idea you decided against stayed on
 * the board for ever, though `wb cancel` would have taken it off all along.
 *
 * Stated as the three endings rather than as the ten statuses that are not, so a
 * status added later is stoppable by default. That is the safe way round: the
 * cost of forgetting is a button that should not be there, not a ticket nothing
 * can stop.
 */
export function ended(t: Ticket): boolean {
  return t.status === 'done' || t.status === 'cancelled' || t.status === 'gave_up';
}

export function deriveTicket(events: Event[]): Ticket {
  const first = events[0];
  if (first === undefined || first.type !== 'ticket_created') {
    throw new Error('event list must start with ticket_created');
  }
  return events.reduce(applyEvent, blank(first.ticketId));
}
