import type { Event, RunOutcome, Stage } from './events.ts';
import { nextAction, type Policy } from './rules.ts';
import { ended, type Status, type Ticket } from './ticket.ts';

/** Where one ticket was put: in front of another, or at the end of the board. */
export type Move = { id: string; before: string | null };

/**
 * The board's order — which is the order work is taken in, so it is the manager's
 * to set. The order tickets were written, with every move applied in the order it
 * was made.
 *
 * A move names a neighbour rather than a position, because a position means
 * something else the moment anything else moves. One that names a ticket no longer
 * there falls to the end rather than being dropped: losing a card off the board
 * because its neighbour was is the worse of the two.
 */
export function ordered(created: readonly string[], moves: readonly Move[]): string[] {
  const ids = [...created];

  for (const { id, before } of moves) {
    const from = ids.indexOf(id);
    if (from === -1) continue;
    ids.splice(from, 1);
    const at = before === null ? -1 : ids.indexOf(before);
    ids.splice(at === -1 ? ids.length : at, 0, id);
  }

  return ids;
}

/**
 * Which statuses make which column. A fact about the lifecycle rather than about
 * any particular board, so it lives here with the rules and is tested like them —
 * the React app and anything else that draws the work read it from one place.
 */
export type Column = { name: string; statuses: readonly Status[] };

export const COLUMNS: readonly Column[] = [
  { name: 'Backlog', statuses: ['backlog'] },
  { name: 'Committed', statuses: ['queued'] },
  { name: 'Planning', statuses: ['planning'] },
  { name: 'Approval', statuses: ['plan_gate'] },
  { name: 'Building', statuses: ['implementing', 'reviewing', 'verifying'] },
  { name: 'Pull request', statuses: ['ready_for_pr', 'awaiting_verdict'] },
  { name: 'Done', statuses: ['done', 'cancelled', 'gave_up'] },
];

/**
 * A blocked ticket keeps the stage it stopped in, so it stays in that stage's
 * column rather than moving to one of its own. That is what has happened: the work
 * has not gone anywhere, it is stuck — and `needsYou` is what says so.
 */
export function columnFor(t: Ticket): string {
  const status: Status = t.status === 'blocked' ? blockedIn(t) : t.status;
  return COLUMNS.find((c) => c.statuses.includes(status))?.name ?? 'Backlog';
}

function blockedIn(t: Ticket): Status {
  switch (t.stage) {
    case 'plan':
      return 'planning';
    case 'implement':
      return 'implementing';
    case 'review':
      return 'reviewing';
    case 'verify':
      return 'verifying';
    // Blocked before any stage ran — the workspace itself failed to open.
    default:
      return 'queued';
  }
}

/**
 * A ticket the workbench would start right now if it had the capacity. Approving
 * four plans at once puts four tickets in Building, of which two run — and until
 * this, the other two said nothing whatever about why they were not. A card with
 * no mark on it reads as a card nothing is going to happen to.
 *
 * Asked of the rule that actually decides rather than restated here: the same
 * question under the current load and under none. Anything else — waiting on you,
 * out of money, finished — answers `wait` both times and is not this.
 *
 * A ticket held behind another is not this, and must not say `queued`: it is not
 * next, and a slot coming free would do nothing for it. It says who it waits for.
 *
 * @param running how many tickets have a stage in flight right now
 * @param held whether the ticket it waits for has not let go yet
 */
export function waitingForSlot(t: Ticket, running: number, policy: Policy, held = false): boolean {
  return (
    nextAction(t, running, policy, held).kind === 'wait' &&
    nextAction(t, 0, policy, held).kind === 'run_stage'
  );
}

/** Whether the ticket is waiting on the manager and on nothing else. */
export function needsYou(t: Ticket): boolean {
  return t.status === 'plan_gate' || t.status === 'blocked';
}

/** How a thing should read: as progress, as a problem, as still going, or as neither. */
export type Tone = 'ok' | 'bad' | 'going' | 'note';

/** Where the ticket is and what it is waiting for, in words. */
export type Headline = { state: string; detail: string; tone: Tone };

/**
 * The one thing a ticket should say before anything else: where it is, and what
 * happens next. The panel had the status only as a word in the chip line, so the
 * loudest thing on a ticket in a pull request was a rejection three stages old —
 * history drawn as if it were news.
 *
 * A fact about the lifecycle rather than about any particular panel, so it lives
 * here beside `columnFor` and is tested like it: every status has a line, and a
 * new status cannot be added without one.
 *
 * @param held the tickets this one is waiting on — `heldBy`, asked by the caller,
 *   which is the one that has the other tickets to hand. Without it a ticket stuck
 *   behind another would claim to be waiting for a slot, which its card denies.
 */
export function headline(t: Ticket, held: readonly Ticket[] = []): Headline {
  switch (t.status) {
    case 'backlog':
      return { state: 'An idea', detail: 'nothing starts until you commit to it', tone: 'note' };
    case 'queued':
      return atStage(t, 'Committed', 'plan', held);
    case 'planning':
      return atStage(t, 'Planning', 'plan', held);
    case 'plan_gate':
      return {
        state: 'Waiting on you',
        detail: 'approve the plan, or send it back',
        tone: 'note',
      };
    case 'implementing':
      return atStage(t, 'Building', 'implement', held);
    case 'reviewing':
      return atStage(t, 'Building', 'review', held);
    case 'verifying':
      return atStage(t, 'Building', 'verify', held);
    case 'ready_for_pr':
      return { state: 'Offering it', detail: 'opening the pull request', tone: 'going' };
    case 'awaiting_verdict':
      return { state: 'Offered', detail: 'waiting on the pull request', tone: 'going' };
    case 'blocked':
      // A stage that stopped to ask is waiting on you; one that fell over is not
      // waiting on anything, and the two need different things done about them.
      return t.question !== null
        ? { state: 'Waiting on you', detail: 'an agent asked you something', tone: 'note' }
        : { state: 'Stuck', detail: 'a stage failed — restart it, or send it back', tone: 'bad' };
    case 'cancelled':
      return { state: 'Cancelled', detail: 'stopped, and nothing will pick it up', tone: 'note' };
    case 'gave_up':
      return { state: 'Given up on', detail: 'the workbench stopped trying', tone: 'bad' };
    case 'done':
      return { state: 'Done', detail: 'merged, and off the board', tone: 'ok' };
  }
}

/**
 * A stage of the loop, running or waiting to. The one thing a twenty-minute stage
 * can say for itself is how far it has got, so it says that when it has said.
 *
 * A ticket held behind another is not waiting for a slot — it is not next, and a
 * slot coming free would do nothing for it. It says who it waits for, the same as
 * its card does, rather than the two contradicting each other.
 */
function atStage(t: Ticket, state: string, stage: Stage, held: readonly Ticket[]): Headline {
  const step = t.step !== null && t.steps.length > 0 ? `, step ${t.step}/${t.steps.length}` : '';
  const waiting =
    held.length > 0
      ? `waiting for ${held.map((h) => h.id).join(', ')}`
      : `waiting for a slot to ${stage}`;
  return { state, detail: t.running ? `${stage} is running${step}` : waiting, tone: 'going' };
}

/**
 * Whether the rejection on the ticket is what it is doing now, rather than what
 * happened to it once. It is never cleared — the brief and the hand-over message
 * both read it — so only the ticket actually acting on it should lead with it.
 */
export function rejectionStands(t: Ticket): boolean {
  return t.status === 'planning' || (t.status === 'blocked' && t.stage === 'plan');
}

/** The same for the changes asked for: the stage putting them right, and no other. */
export function changesStand(t: Ticket): boolean {
  return t.status === 'implementing' || (t.status === 'blocked' && t.stage === 'implement');
}

/**
 * Whether there is anything to say no to. Both of the manager's noes send the
 * ticket back into the loop, so both need work under way to send back.
 *
 * Not while a stage is running: that run still reports back, and `afterStage`
 * would land its verdict on a ticket that had already moved. Not before anything
 * has started either — a ticket in the backlog or the queue has produced nothing
 * to object to, and sending it back would start it.
 */
export function sendableBack(t: Ticket): boolean {
  return !ended(t) && !t.running && t.status !== 'backlog' && t.status !== 'queued';
}

/**
 * A ticket nothing will pick up again, with commits on its branch that nothing can
 * reach. The card says so and the panel offers to carry on from it — one rule, so
 * the flag that promises salvage and the button that does it cannot disagree.
 */
export function salvageable(t: Ticket): boolean {
  return (t.status === 'cancelled' || t.status === 'gave_up') && t.commits.length > 0;
}

/** The ticket a suggestion proposes: a name, what it says, and its description. */
export type Suggestion = {
  title: string;
  /** The rest of the line — what the row shows under the name. */
  what: string;
  /** `what`, under a line saying which run suggested it. */
  body: string;
};

/**
 * The ticket a suggestion proposes. Stages write one as `<name> — <what and why>`,
 * so the name is the ticket's title and the rest is its description.
 *
 * One definition, used both to write that ticket and to recognise it afterwards, so
 * the two cannot drift apart into a suggestion nothing can tell has been taken up.
 */
export function suggestion(from: Ticket, stage: Stage, idea: string): Suggestion {
  const [title, what] = named(idea.trim());
  const from_ = `Suggested by ${stage} of ${from.id} — ${from.title}.`;
  return { title, what, body: what === '' ? from_ : `${what}\n\n${from_}` };
}

/** As long as a ticket title should be. Everything past it is the description. */
const NAME = 60;

/**
 * An idea split at the dash the stages are told to write. One that has no dash in
 * the first `NAME` characters is cut at a word instead — a stage that forgot to
 * name its idea, or dashed a clause halfway down a paragraph, would otherwise put
 * that paragraph on a card, in the pull request title and in the merge commit.
 */
function named(idea: string): [title: string, what: string] {
  const dash = /\s+[—–-]\s+/.exec(idea.slice(0, NAME + 1));
  if (dash) return [idea.slice(0, dash.index), idea.slice(dash.index + dash[0].length).trim()];
  if (idea.length <= NAME) return [idea, ''];
  const title = idea.slice(0, NAME).replace(/\s+\S*$/, '');
  return [title, idea.slice(title.length).trim()];
}

/**
 * The ticket a suggestion was already made into, if it was. Nothing links the two
 * — the new ticket is a ticket of its own and the suggestion is an event on this
 * one — so they are matched on what was written.
 *
 * Derived rather than remembered, because a button that only disabled itself would
 * be offering to make the same ticket again the moment the panel was reopened.
 */
export function madeInto(
  tickets: readonly Ticket[],
  from: Ticket,
  stage: Stage,
  idea: string,
): Ticket | undefined {
  const { title, body } = suggestion(from, stage, idea);
  return tickets.find((t) => t.title === title && t.body === body);
}

/**
 * Fields already on the line an event is drawn as, or the same for every event in
 * a stage. Everything else is what opening that line is for.
 */
const ON_THE_LINE = ['type', 'id', 'ticketId', 'at', 'runId'];

/**
 * Everything an event's one-line summary leaves out — which is most of what the
 * agents did. A plan run writes thousands of words and a tool call carries the
 * arguments it was really given; both are recorded, and neither fits on a line.
 *
 * No switch on the event type: one rule reads what is there, so an event that
 * gains a field shows it without this being touched.
 *
 * @param shown what the line already says, so it is not said twice. A
 *   `stage_started` is only its stage, and opening it should offer nothing.
 */
export function details(e: Event, shown = ''): [field: string, value: string][] {
  return Object.entries(e)
    .filter(([field, value]) => !ON_THE_LINE.includes(field) && value !== undefined)
    .filter(([, value]) => value !== shown)
    .map(([field, value]): [string, string] => [
      field,
      // Prose stays prose. Anything else is worth seeing in full — a tool's input
      // is where what it was actually asked to do lives.
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    ])
    .filter(([, value]) => value !== '');
}

/** One stage run, as much of it as has happened. What a card shows per stage. */
export type Run = {
  stage: Stage;
  outcome: RunOutcome | 'running';
  summary: string;
  /** Set when the stage did not approve. The reason the ticket went round again. */
  rejected: string | null;
  /**
   * Set when the stage asked for the work to be put right rather than done again.
   * Without it a review that sent the work back reads as `done`, and the implement
   * stage that follows it looks like one that ran for no reason.
   */
  changes: string | null;
  question: string | null;
  costUsd: number;
  toolCalls: number;
  /** Tools the guard refused. Few and worth seeing, so they are named, not counted. */
  refused: string[];
  checks: { passed: number; failed: number } | null;
  /**
   * Improvements this run thought worth making that are not this ticket's job.
   * Kept beside the run that noticed them, where the manager can make tickets of
   * them — which is the whole reason a reviewer has somewhere to put a good idea
   * other than the verdict.
   */
  later: string[];
  at: string;
};

/**
 * What actually happened to a run, in a word. `outcome` alone does not say: a
 * review that rejected the work finished perfectly well, and reads as `completed`.
 */
export function statusOf(run: Run): string {
  if (run.outcome === 'running') return 'running';
  if (run.outcome === 'blocked') return 'asked you';
  if (run.outcome === 'failed') return 'failed';
  if (run.rejected !== null) return 'did not approve';
  if (run.changes !== null) return 'asked for changes';
  if (run.checks !== null && run.checks.failed > 0) return 'checks failed';
  return 'done';
}

/**
 * How that word should read: as progress, as a problem, or as still going. Asking
 * for changes is none of the three — the work was sound and is being finished —
 * so it gets no colour rather than borrowing one that means something else.
 */
export function toneOf(run: Run): Tone {
  if (run.outcome === 'running') return 'going';
  if (run.outcome === 'failed' || run.rejected !== null) return 'bad';
  if (run.checks !== null && run.checks.failed > 0) return 'bad';
  if (run.changes !== null) return 'note';
  return 'ok';
}

/**
 * The ticket's history folded into one block per stage run. An agent produces far
 * more than anyone wants to read, and the raw log is still there underneath — this
 * is the summary the board leads with.
 *
 * A run is the span between `stage_started` and `stage_finished`, and everything
 * inside it belongs to it. Grouping by `runId` would say the same thing for a run
 * that ended normally — but a workbench that died mid-stage has its run closed off
 * by `reconcile`, under the id `interrupted`, and that report belongs to the stage
 * it ends rather than to a run of its own.
 */
export function runs(events: readonly Event[]): Run[] {
  const all: Run[] = [];
  let open: Run | null = null;

  for (const e of events) {
    switch (e.type) {
      case 'stage_started':
        open = {
          stage: e.stage,
          outcome: 'running',
          summary: '',
          rejected: null,
          changes: null,
          question: null,
          costUsd: 0,
          toolCalls: 0,
          refused: [],
          checks: null,
          later: [],
          at: e.at,
        };
        all.push(open);
        break;

      case 'tool_requested':
        if (open === null) break;
        open.toolCalls += 1;
        if (!e.allowed) open.refused.push(e.tool);
        break;

      case 'checks_run':
        if (open === null) break;
        open.checks = {
          passed: e.results.filter((r) => r.ok).length,
          failed: e.results.filter((r) => !r.ok).length,
        };
        break;

      case 'question_asked':
        if (open !== null) open.question = e.question;
        break;

      case 'stage_finished':
        if (open === null) break;
        open.outcome = e.outcome;
        open.summary = e.summary;
        open.rejected = e.rejected ?? null;
        open.changes = e.changes ?? null;
        open.costUsd = e.costUsd ?? 0;
        open.later = e.later ?? [];
        open = null;
        break;

      default:
        break; // not part of any run
    }
  }

  return all;
}
