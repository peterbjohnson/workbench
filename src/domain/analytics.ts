import { COLUMNS, columnFor } from './board.ts';
import type { Event, RunOutcome, Scale, Stage } from './events.ts';
import type { Ticket } from './ticket.ts';

/**
 * What became of a ticket, in the one word the Done column mixes three of. Not a
 * status: `done`, `cancelled` and `gave_up` all sit in the same column and read as
 * the same kind of card, and the difference between them is the most useful thing
 * to sort or filter a finished board by.
 */
export type Outcome = 'accepted' | 'cancelled' | 'gave_up' | 'open';

export function outcomeOf(t: Ticket): Outcome {
  if (t.status === 'done') return 'accepted';
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'gave_up') return 'gave_up';
  return 'open';
}

/**
 * The `word:` a title is written behind, or null for one written without. The
 * settings offer a list of these and the ticket form puts one in front of most
 * titles, so it is the closest thing the board has to a kind of work.
 */
export function prefixOf(title: string): string | null {
  // The colon has to end the word: `http://example.com` is a URL, not a kind of work.
  return /^([A-Za-z][A-Za-z0-9-]*):(\s|$)/.exec(title)?.[1]?.toLowerCase() ?? null;
}

/** One stage run, as long as it took and what it cost. */
export type StageRun = {
  ticketId: string;
  stage: Stage;
  /** Null while the run never finished — a workbench stopped, or one still going. */
  outcome: RunOutcome | null;
  costUsd: number;
  /** How long it ran, from the two timestamps. Null for a run with no finish. */
  ms: number | null;
};

/**
 * Every stage run in the log, finished or not. A run is the span between
 * `stage_started` and the next `stage_finished` on the same ticket — matched that
 * way rather than on `runId`, because a run closed off by `reconcile` is finished
 * under the id `interrupted` and pairing on the id would lose it.
 *
 * Events from every ticket arrive in one list, so the open run is kept per ticket:
 * two tickets running at once interleave, and one's finish must not close the other.
 */
export function stageRuns(events: readonly Event[]): StageRun[] {
  const all: StageRun[] = [];
  const open = new Map<string, { run: StageRun; startedAt: string }>();

  for (const e of events) {
    if (e.type === 'stage_started') {
      const run: StageRun = {
        ticketId: e.ticketId,
        stage: e.stage,
        outcome: null,
        costUsd: 0,
        ms: null,
      };
      open.set(e.ticketId, { run, startedAt: e.at });
      all.push(run);
    } else if (e.type === 'stage_finished') {
      const started = open.get(e.ticketId);
      if (started === undefined) continue;
      started.run.outcome = e.outcome;
      started.run.costUsd = e.costUsd ?? 0;
      started.run.ms = span(started.startedAt, e.at);
      open.delete(e.ticketId);
    }
  }

  return all;
}

/** One labelled number. Every list and bar on the tab is drawn from these. */
export type Slice = { label: string; value: number };

/** A ticket named by what it cost, for the lists that rank them. */
export type TicketCost = { id: string; title: string; costUsd: number };

/** Per stage, what its runs did and what they took. */
export type StageStat = {
  stage: Stage;
  runs: number;
  /** The outcome mix, one slice per `RunOutcome` plus the runs still open. */
  outcomes: Slice[];
  medianMs: number | null;
  meanUsd: number;
};

export type Analytics = {
  headline: {
    tickets: number;
    byColumn: Slice[];
    accepted: number;
    cancelled: number;
    gaveUp: number;
    /** Accepted as a share of the tickets that ended. Zero when none has. */
    acceptanceRate: number;
    /** What the stages spent. Chat is deliberately not in it, as on the ticket. */
    totalUsd: number;
    chatUsd: number;
    meanAcceptedUsd: number;
    medianAcceptedUsd: number;
    dearest: TicketCost | null;
  };
  money: {
    byStage: Slice[];
    byScale: Slice[];
    dearest: TicketCost[];
    histogram: Slice[];
  };
  flow: {
    /** The last twelve weeks, oldest first, counted by the tickets that ended in them. */
    perWeek: Slice[];
    /** Queued to accepted: how long a ticket takes once it is committed to. */
    medianLeadMs: number | null;
    /** First stage started to accepted — the same span, less the wait for a slot. */
    medianBuildMs: number | null;
    approvals: number;
    rejections: number;
    meanCycles: number;
    meanRevisions: number;
    meanCommits: number;
  };
  agents: {
    stages: StageStat[];
    /** Questions asked, by the stage that asked them. */
    questions: Slice[];
    tools: Slice[];
    toolCalls: number;
    refused: number;
    checks: { passed: number; failed: number };
  };
};

const STAGES: readonly Stage[] = ['plan', 'implement', 'review', 'verify'];
const SCALES: readonly Scale[] = ['small', 'standard', 'large'];
const OUTCOMES: readonly RunOutcome[] = ['completed', 'blocked', 'failed', 'interrupted'];

/** How many tools are worth naming. The tail is a long list of one call each. */
const TOP_TOOLS = 15;
/** How many of the most expensive tickets the money section lists. */
const TOP_TICKETS = 10;

/**
 * Everything the Analytics tab shows, worked out here so the component draws and
 * computes nothing. Pure, over the tickets the store derived and every event in
 * the log — the durations, the throughput and the per-stage costs are nowhere on
 * a `Ticket`, and only the timestamps and `stage_finished` bodies have them.
 */
export function analyse(tickets: readonly Ticket[], events: readonly Event[]): Analytics {
  const runs = stageRuns(events);
  const stageOf = new Map(
    events.flatMap((e) => (e.type === 'stage_started' ? [[e.runId, e.stage] as const] : [])),
  );
  const ending = endings(events);

  const accepted = tickets.filter((t) => outcomeOf(t) === 'accepted');
  const cancelled = tickets.filter((t) => outcomeOf(t) === 'cancelled');
  const gaveUp = tickets.filter((t) => outcomeOf(t) === 'gave_up');
  const finished = accepted.length + cancelled.length + gaveUp.length;
  const acceptedCosts = accepted.map((t) => t.costUsd);
  const spent = [...tickets].sort((a, b) => b.costUsd - a.costUsd);
  const chatUsd = sum(events.map((e) => (e.type === 'chat_said' ? (e.costUsd ?? 0) : 0)));

  const toolCalls = events.filter((e) => e.type === 'tool_requested');
  const checks = events.flatMap((e) => (e.type === 'checks_run' ? e.results : []));

  return {
    headline: {
      tickets: tickets.length,
      byColumn: COLUMNS.map((c) => ({
        label: c.name,
        value: tickets.filter((t) => columnFor(t) === c.name).length,
      })),
      accepted: accepted.length,
      cancelled: cancelled.length,
      gaveUp: gaveUp.length,
      acceptanceRate: finished === 0 ? 0 : accepted.length / finished,
      totalUsd: sum(tickets.map((t) => t.costUsd)),
      chatUsd,
      meanAcceptedUsd: mean(acceptedCosts),
      medianAcceptedUsd: median(acceptedCosts) ?? 0,
      dearest: spent[0] !== undefined && spent[0].costUsd > 0 ? cost(spent[0]) : null,
    },

    money: {
      byStage: STAGES.map((stage) => ({
        label: stage,
        value: sum(runs.filter((r) => r.stage === stage).map((r) => r.costUsd)),
      })),
      byScale: SCALES.map((scale) => ({
        label: scale,
        value: sum(tickets.filter((t) => t.scale === scale).map((t) => t.costUsd)),
      })),
      dearest: spent
        .filter((t) => t.costUsd > 0)
        .slice(0, TOP_TICKETS)
        .map(cost),
      histogram: histogram(tickets.map((t) => t.costUsd)),
    },

    flow: {
      perWeek: perWeek([...ending.values()]),
      medianLeadMs: median(spans(events, 'queued')),
      medianBuildMs: median(spans(events, 'stage_started')),
      approvals: events.filter((e) => e.type === 'plan_approved').length,
      rejections: events.filter((e) => e.type === 'plan_rejected').length,
      meanCycles: mean(accepted.map((t) => t.cycles)),
      meanRevisions: mean(accepted.map((t) => t.revisions)),
      meanCommits: mean(accepted.map((t) => t.commits.length)),
    },

    agents: {
      stages: STAGES.map((stage) => {
        const its = runs.filter((r) => r.stage === stage);
        return {
          stage,
          runs: its.length,
          outcomes: [
            ...OUTCOMES.map((outcome) => ({
              label: outcome,
              value: its.filter((r) => r.outcome === outcome).length,
            })),
            { label: 'running', value: its.filter((r) => r.outcome === null).length },
          ].filter((s) => s.value > 0),
          medianMs: median(its.flatMap((r) => (r.ms === null ? [] : [r.ms]))),
          meanUsd: mean(its.map((r) => r.costUsd)),
        };
      }),
      questions: STAGES.map((stage) => ({
        label: stage,
        value: events.filter((e) => e.type === 'question_asked' && stageOf.get(e.runId) === stage)
          .length,
      })),
      tools: byCount(toolCalls.map((e) => (e.type === 'tool_requested' ? e.tool : ''))).slice(
        0,
        TOP_TOOLS,
      ),
      toolCalls: toolCalls.length,
      refused: toolCalls.filter((e) => e.type === 'tool_requested' && !e.allowed).length,
      checks: {
        passed: checks.filter((c) => c.ok).length,
        failed: checks.filter((c) => !c.ok).length,
      },
    },
  };
}

function cost(t: Ticket): TicketCost {
  return { id: t.id, title: t.title, costUsd: t.costUsd };
}

/** When each ticket ended, for the ones that have. Nothing reopens a ticket. */
function endings(events: readonly Event[]): Map<string, string> {
  const at = new Map<string, string>();
  for (const e of events) {
    const over =
      e.type === 'cancelled' ||
      e.type === 'gave_up' ||
      (e.type === 'verdict' && e.verdict === 'accepted');
    if (over) at.set(e.ticketId, e.at);
  }
  return at;
}

/**
 * How long each accepted ticket took, measured from the first event of `from` on
 * it. Two spans are worth telling apart: from being committed to, which includes
 * the wait for a slot, and from the first stage actually starting, which does not.
 */
function spans(events: readonly Event[], from: 'queued' | 'stage_started'): number[] {
  const started = new Map<string, string>();
  const took: number[] = [];

  for (const e of events) {
    if (e.type === from && !started.has(e.ticketId)) started.set(e.ticketId, e.at);
    if (e.type !== 'verdict' || e.verdict !== 'accepted') continue;
    const at = started.get(e.ticketId);
    const ms = at === undefined ? null : span(at, e.at);
    if (ms !== null) took.push(ms);
  }

  return took;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/** How many weeks of throughput the flow section draws. A quarter, near enough. */
const WEEKS = 12;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Tickets finished per week, oldest first. The twelve weeks run back from the last
 * one anything ended in rather than from today: a board nobody has touched this
 * month would otherwise draw twelve empty columns and say nothing at all.
 */
function perWeek(endings: readonly string[]): Slice[] {
  const times = endings.map((at) => Date.parse(at)).filter((ms) => !Number.isNaN(ms));
  if (times.length === 0) return [];

  const from = monday(Math.max(...times)) - (WEEKS - 1) * WEEK;
  return Array.from({ length: WEEKS }, (_, i) => {
    const start = from + i * WEEK;
    return {
      label: label(start),
      value: times.filter((ms) => ms >= start && ms < start + WEEK).length,
    };
  });
}

/** The start of the UTC week a moment falls in. Weeks start on Monday. */
function monday(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
}

function label(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/** Where the cost buckets are cut, in dollars. The last bucket is everything above. */
const BUCKETS = [0.5, 1, 2, 5, 10];

function histogram(costs: readonly number[]): Slice[] {
  const spent = costs.filter((c) => c > 0);
  const under = (limit: number) => spent.filter((c) => c < limit).length;
  return [
    { label: `< $${BUCKETS[0]?.toFixed(2) ?? ''}`, value: under(BUCKETS[0] ?? 0) },
    ...BUCKETS.slice(1).map((limit, i) => ({
      label: `$${(BUCKETS[i] ?? 0).toFixed(2)}–${limit.toFixed(2)}`,
      value: under(limit) - under(BUCKETS[i] ?? 0),
    })),
    {
      label: `$${(BUCKETS[BUCKETS.length - 1] ?? 0).toFixed(2)}+`,
      value: spent.length - under(BUCKETS[BUCKETS.length - 1] ?? 0),
    },
  ];
}

/** How many of each thing there were, most first. Ties keep the order they arrived in. */
function byCount(names: readonly string[]): Slice[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/** Milliseconds between two event stamps, or null if either is not a date. */
function span(from: string, to: string): number | null {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isNaN(ms) ? null : ms;
}

function sum(ns: readonly number[]): number {
  return ns.reduce((total, n) => total + n, 0);
}

/** Zero for nothing, rather than the `NaN` an empty board would otherwise show. */
function mean(ns: readonly number[]): number {
  return ns.length === 0 ? 0 : sum(ns) / ns.length;
}

/** Null for nothing: a median of no numbers is not a number, and says so. */
function median(ns: readonly number[]): number | null {
  if (ns.length === 0) return null;
  const sorted = [...ns].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[half] as number)
    : ((sorted[half - 1] as number) + (sorted[half] as number)) / 2;
}
