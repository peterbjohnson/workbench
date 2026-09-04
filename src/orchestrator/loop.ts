import { randomUUID } from 'node:crypto';

import type { CheckRun, EventBody, Refreshed, RunOutcome, Scale, Stage } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { carriedWork, heldBy, nextAction, type Action } from '../domain/rules.ts';
import type { Store } from '../store/store.ts';
import { isCredentialRejection, refused, type Credentials } from '../run/credentials.ts';
import { readStep } from '../run/protocol.ts';
import { createBranch } from './branch.ts';
import { createMerging } from './merging.ts';
import { describe } from './describe.ts';

/** An action that has something to carry out — everything except waiting. */
type Doable = Exclude<Action, { kind: 'wait' }>;

/**
 * What a stage run reports back. The orchestrator turns this into events.
 *
 * A runner never reports `interrupted`; the orchestrator writes it over whatever
 * the run said, for a run it stopped underneath. See `interrupt`.
 */
export type RunResult = {
  outcome: RunOutcome;
  summary: string;
  /** Set by review and verify when the approach itself is wrong. */
  rejected?: string;
  /** Set by review and verify when the approach is right and details are not. */
  changes?: string;
  /** Set by the plan stage: how much it judged the work to warrant. */
  scale?: Scale;
  /** Set by the plan stage: what the work breaks into, in order. */
  steps?: string[];
  /** Set by the plan stage: what would make this ticket finished. */
  completionCriteria?: string[];
  /** Improvements worth a later ticket, which are not this one's job. */
  later?: string[];
  /** Set when the agent asked the manager something. */
  question?: { question: string; reasoning: string };
  /**
   * The conversation this run was, kept only when it stopped with something left
   * to say. Answering the question resumes it rather than starting again. A run
   * that is still going says the same thing with `session_started`, which is what
   * survives the workbench being killed under it.
   */
  sessionId?: string;
  /** What the run cost, as the model service reported it. */
  costUsd?: number;
};

export type StageRunner = (args: {
  ticket: Ticket;
  stage: Stage;
  /**
   * Which run this is, as `stage_started` recorded it. Everything the run emits
   * carries it, so a ticket's history says which stage each line came from without
   * anyone having to work it out from the order.
   */
  runId: string;
  worktree: string;
  /** Where working-out goes. Writable, and not part of what gets committed. */
  scratch: string;
  /**
   * The standing checks, already run and already passed. Given to verify so it does
   * not spend turns running them, and knows what was covered without an agent.
   */
  checks?: CheckRun[];
  /**
   * A merge the workbench started and could not finish, left in the worktree for
   * this stage to resolve before it does anything else. The stage may not end with
   * any of these paths still conflicted.
   */
  conflict?: { base: string; paths: string[] };
  /**
   * The conversation to pick back up, when there is one: a question the manager
   * has now answered, or a run the workbench was stopped in the middle of. Still
   * best-effort — a runner that cannot resume must start the stage afresh rather
   * than fail, because the session lives on one machine and can simply be gone.
   */
  resume?: string;
  /** Called as the run proceeds, for the live record. */
  emit: (body: EventBody) => void;
  /** Aborted when the manager cancels the ticket. */
  signal: AbortSignal;
}) => Promise<RunResult>;

export type Verdict =
  { kind: 'pending' } | { kind: 'accepted' } | { kind: 'rejected'; reason: string };

/** Somewhere for a ticket to do its work, without treading on any other ticket. */
export type Workspace = {
  /**
   * Makes the ticket's workspace if it does not have one. `base` is the commit the
   * work was cut from, and is set only on the call that created it. `scratch` is
   * writable but is not part of what `commit` records.
   */
  prepare: (
    ticketId: string,
    /** The branch to start from, when this ticket carries on from another. */
    from?: string,
  ) => Promise<{ path: string; scratch: string; base: string | null }>;
  /**
   * Brings the base as the code host now has it into the ticket's branch, so the
   * work is offered against the code that exists rather than the code that did
   * when it started. `up-to-date` is the ordinary answer and means nothing
   * happened at all.
   */
  refresh: (
    ticketId: string,
    /**
     * Branches to bring in besides the base: the work this ticket waited for,
     * which is offered and so is not in the base yet.
     */
    alsoMerge?: readonly string[],
    /**
     * Leave a conflict in the worktree rather than undoing it, because the caller
     * is about to run a stage that can resolve it. At ship time there is nobody
     * left to, so the default is to put the branch back as it was.
     */
    keepConflict?: boolean,
  ) => Promise<Refreshed>;
  /**
   * Of the paths a stage was handed a merge for, which ones it has not finished:
   * still unmerged, or still holding the markers. Asked at the end of that stage,
   * because committing an unresolved merge would put the markers on the branch.
   */
  unresolved: (ticketId: string, paths: readonly string[]) => Promise<string[]>;
  /**
   * Records whatever a stage left behind, returning the commit or null when there
   * was nothing to record — normal for the stages that only read. The sha is kept:
   * a ticket's record is its branch, its base, its commits and its pull request.
   */
  commit: (ticket: Ticket, message: string) => Promise<string | null>;
  /** Called once a ticket is accepted. The branch is left alone: it is in the PR. */
  discard: (ticketId: string) => Promise<void>;
};

/** Where finished work is offered, and where the manager's answer comes back from. */
export type CodeHost = {
  openPr: (ticket: Ticket) => Promise<string>;
  verdict: (ticket: Ticket) => Promise<Verdict>;
  /** Merges the offer, because the manager said so here rather than on the host. */
  merge: (ticket: Ticket) => Promise<void>;
};

export type Deps = {
  store: Store;
  workspace: Workspace;
  host: CodeHost;
  runStage: StageRunner;
  /**
   * Runs the standing checks in a ticket's worktree. The workbench's own job, not an
   * agent's: an agent reporting that the tests passed is a claim, and the verify
   * agent's instructions concede as much. Run here, it is a fact.
   *
   * Never throws — a command that fails, times out or does not exist comes back as
   * a failed check, because to the rules those are all the same thing.
   */
  checks: (worktree: string) => Promise<CheckRun[]>;
  /**
   * Whether the workbench can talk to the model service at all. Asked before any
   * stage starts, because being logged out is a kind of having no capacity.
   */
  credentials: () => Promise<Credentials>;
  /** Says something to whoever is watching. The CLI prints it; tests collect it. */
  announce: (message: string) => void;
};

export type Orchestrator = {
  /** Do whatever the rules currently permit. Safe to call at any time. */
  tick: () => Promise<unknown>;
  /** Resolves once nothing is in flight and no further action is permitted. */
  idle: () => Promise<void>;
  /**
   * Stop the stages still running, and say which they were. The second press of
   * the board's STOP: the first left them to finish.
   */
  interrupt: () => string[];
  start: () => void;
  stop: () => Promise<void>;
};

/**
 * A ticket is running because a `stage_started` was never answered by a
 * `stage_finished`. If the workbench died in between, nothing will ever answer it:
 * the ticket stays running for ever, and holds a work-in-progress slot for ever.
 * Closing those runs off at startup parks them as blocked — visible and answerable
 * — instead of wedged.
 *
 * Closed as `interrupted` rather than `failed`, carrying whatever conversation the
 * run had got as far as naming. That is the difference between a stage that can
 * carry on and one that has to be bought again, and restarting is routine now: it
 * is how an update is picked up.
 *
 * @returns the tickets that were picked up mid-stage.
 */
export function reconcile(store: Store): string[] {
  const interrupted = store.tickets().filter((t) => t.running);

  for (const ticket of interrupted) {
    store.append(ticket.id, {
      type: 'stage_finished',
      runId: 'interrupted',
      outcome: 'interrupted',
      summary: 'the workbench stopped while this stage was running',
      sessionId: ticket.session ?? undefined,
    });
  }

  return interrupted.map((t) => t.id);
}

export function createOrchestrator(deps: Deps, opts: { pollMs?: number } = {}): Orchestrator {
  const { store } = deps;
  const pollMs = opts.pollMs ?? 30_000;

  /** Tickets whose work is in flight in this process, so a tick never starts one twice. */
  const inFlight = new Map<string, Promise<void>>();
  /** How a cancellation reaches a run that has already started. */
  const aborts = new Map<string, AbortController>();
  /**
   * Tickets whose run was stopped by `interrupt` rather than by the manager
   * cancelling the ticket. Both arrive at the run as the same aborted signal, and
   * this is what tells them apart when it comes back.
   */
  const broken = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let listening = false;
  /** So the credential state is announced when it changes, not on every tick. */
  let wasOk = true;
  /**
   * Set when the model service refuses the credential we have. Sticky on purpose:
   * checking that a credential is *present* cannot tell you it is *accepted*, and
   * the only authority on that is a real call. Once one comes back rejected, no
   * amount of re-checking locally will change the answer — the credential itself
   * has to change, and for an environment variable that means a restart.
   */
  let rejection: string | undefined;

  /** A ticket's branch, and the offer made of what is on it. */
  const branch = createBranch(deps);
  const merging = createMerging({ deps, branch, busy: (id) => inFlight.has(id) });

  // Subscribed from the moment the orchestrator exists, not from start(), because a
  // cancellation has to reach a running stage whether or not the timer is going.
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'cancelled') aborts.get(event.ticketId)?.abort();
    if (listening) void tick();
  });

  /**
   * Whether agents may run at all. Being logged out is not a broken workbench and
   * not a broken ticket: it is having no capacity. Nothing starts, so nothing is
   * spent, no cycle is used and no worktree is made — and the manager can still
   * write, approve and cancel.
   *
   * Said once when the answer changes, rather than on every tick.
   */
  async function canRunAgents(): Promise<boolean> {
    const credentials = rejection === undefined ? await deps.credentials() : refused(rejection);
    if (credentials.ok === wasOk) return credentials.ok;
    wasOk = credentials.ok;

    deps.announce(
      credentials.ok
        ? `authenticated with ${credentials.how} — carrying on`
        : `⚠️  agent work is paused: ${credentials.why}.\n\n${credentials.fix}\n\n` +
            'The rest of the workbench still works — write tickets, approve, cancel.' +
            // Only true when the credential could still turn up. A refused one has
            // to be replaced, and this process cannot see that happen.
            (rejection === undefined ? '\nThey will start on their own once this is sorted.' : ''),
    );
    return credentials.ok;
  }

  /**
   * @param poll whether to ask the code host for verdicts. Only the timer does:
   *   a pull request has no event to wait for, and polling on every appended
   *   event would mean asking GitHub continuously and never settling.
   */
  async function tick({ poll = false }: { poll?: boolean } = {}): Promise<boolean> {
    if (stopped) return false;
    // The manager stopped the whole workbench. Nothing starts at all — not a stage,
    // not a pull request, not a verdict poll — until `wb start`. Asked before the
    // tickets are read, because being stopped is not a fact about any of them.
    if (store.stopped()) return false;

    /**
     * Whether this pass found anything happening: work it started, or a ticket it
     * had to skip because a run was already going. Polling a pull request counts as
     * neither — it stays available for as long as a human has not answered, so
     * counting it would mean never settling.
     */
    let active = false;

    const tickets = store.tickets();
    const policy = store.policy();
    const mayRunAgents = await canRunAgents();

    // A ticket occupies one slot whether the store already shows it running or it
    // is only just starting. Counting both would charge it twice and jam the limit.
    const busy = new Set(tickets.filter((t) => t.running).map((t) => t.id));
    for (const id of inFlight.keys()) busy.add(id);

    for (const ticket of tickets) {
      // Busy is not idle. A run started by the tick that follows a finished one is
      // not in the set `idle` is waiting on, so a pass that skips it here and
      // settles would return with work still going.
      if (inFlight.has(ticket.id)) {
        active = true;
        continue;
      }

      const action = nextAction(ticket, busy.size, policy, heldBy(ticket, tickets).length > 0);
      if (action.kind === 'wait') continue;
      if (action.kind === 'poll_verdict' && !poll) continue;
      // Only running a stage needs the model service. Opening a pull request, reading
      // a verdict and giving up are the workbench's own work and carry on regardless.
      if (action.kind === 'run_stage' && !mayRunAgents) continue;
      // Queued, not refused: nothing is appended and `mergeRequested` still stands,
      // so the tick after the gate frees is the one that merges it — in this process
      // or in the one that replaces it, since the request is a durable event and the
      // queue is only ever this tick declining to act on it.
      if (action.kind === 'merge_pr' && merging.merging()) {
        merging.tellQueued(ticket);
        active = true;
        continue;
      }
      if (action.kind === 'run_stage') busy.add(ticket.id);

      if (action.kind !== 'poll_verdict') active = true;

      const work = perform(ticket, action).finally(() => {
        // Free the slot first, then look for work: a tick that ran before this
        // would still see the finished ticket as busy and leave the slot idle.
        inFlight.delete(ticket.id);
        void tick();
      });
      inFlight.set(ticket.id, work);
    }

    return active;
  }

  async function perform(ticket: Ticket, action: Doable): Promise<void> {
    try {
      switch (action.kind) {
        case 'run_stage':
          await doStage(ticket, action.stage);
          break;
        case 'open_pr':
          await merging.openPr(ticket);
          break;
        case 'poll_verdict':
          await merging.pollVerdict(ticket);
          break;
        case 'merge_pr':
          await merging.mergePr(ticket);
          break;
        case 'give_up':
          store.append(ticket.id, { type: 'gave_up', reason: action.reason });
          break;
        case 'hand_over':
          store.append(ticket.id, { type: 'blocked', reason: action.reason });
          break;
      }
    } catch (error) {
      store.append(ticket.id, { type: 'blocked', reason: describe(error) });
    }
  }

  /**
   * The standing checks, run by the workbench at the start of verify.
   *
   * Running them here rather than asking an agent to changes what a pass *is*: an
   * observed fact in the ticket's record instead of a report from something with an
   * opinion. It also makes failure the cheap path — the run that discovers a broken
   * test now costs nothing at all, where it used to cost a whole verify stage.
   *
   * @returns the results to hand the agent, or null when a check failed and the
   *   ticket has already been sent back.
   */
  async function standingChecks(
    ticket: Ticket,
    runId: string,
    worktree: string,
  ): Promise<CheckRun[] | null> {
    const results = await deps.checks(worktree);
    if (results.length === 0) return results;

    store.append(ticket.id, { type: 'checks_run', runId, results });

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) return results;

    // Back to planning through the path a rejection already takes. The output is the
    // reason, because a summary of a test failure is worse than the failure.
    store.append(ticket.id, {
      type: 'stage_finished',
      runId,
      outcome: 'completed',
      summary: `${failed.length} of ${results.length} standing check(s) failed`,
      rejected: failed.map((f) => `\`${f.command}\` failed:\n${f.output}`).join('\n\n'),
    });
    return null;
  }

  async function doStage(ticket: Ticket, stage: Stage): Promise<void> {
    const { path: worktree, scratch } = await branch.prepare(ticket);
    const runId = randomUUID();

    // Interruptible from the moment it is running, not from the moment the agent
    // starts. Everything between the two — the refresh, the standing checks — is
    // this run happening, and a STOP pressed during it used to find nothing to
    // abort, report that nothing was abandoned, and then let the stage go on and
    // buy the whole agent run it was pressed to prevent.
    const abort = new AbortController();
    aborts.set(ticket.id, abort);

    try {
      store.append(ticket.id, { type: 'stage_started', stage, runId });

      const conflict = await branch.refreshForStage(ticket, stage, runId);
      // A merge that landed moved the base on the stored ticket, and everything
      // downstream — the brief's diff above all — is taken from the object rather than
      // the store. Without this the stage sees the base it was cut from, and the whole
      // of the merged-in work reads as its own. The base alone, not the whole ticket:
      // the one held here is deliberately the one from before `stage_started`, which
      // clears the answer and the session this run is about to carry in.
      ticket = { ...ticket, base: store.ticket(ticket.id).base };

      let checks: CheckRun[] | undefined;
      // Not while a merge is waiting: the checks would be run against a tree full of
      // conflict markers, fail for that and nothing else, and send the ticket back to
      // planning before the agent had so much as looked at it. Resolving the merge is
      // the first thing this run does, and they are asked at the far end of it, once
      // there is a tree worth asking about.
      if (stage === 'verify' && conflict === undefined) {
        const passed = await standingChecks(ticket, runId, worktree);
        if (passed === null) {
          // Rejected, and no agent was asked. The stage is over, so it is no longer
          // anyone's to stop: a name left in either of these belongs to a run that has
          // ended, and would be answered by whatever ran next under the same id.
          aborts.delete(ticket.id);
          broken.delete(ticket.id);
          return;
        }
        checks = passed;
      }

      // Stopped before the agent was ever asked. Recorded as `interrupted` — the same
      // as a run stopped mid-flight — rather than started and immediately abandoned,
      // which is the difference between a STOP that costs nothing and one that costs a
      // stage. The session is the one this run was about to resume, because it never
      // got as far as naming one of its own.
      if (broken.delete(ticket.id)) {
        aborts.delete(ticket.id);
        store.append(ticket.id, {
          type: 'stage_finished',
          runId,
          outcome: 'interrupted',
          summary: 'stopped by the manager',
          sessionId: ticket.session ?? undefined,
        });
        return;
      }

      let commit: string | null = null;
      let result: RunResult;
      try {
        result = await deps.runStage({
          ticket,
          stage,
          runId,
          worktree,
          scratch,
          checks,
          conflict,
          // Whatever conversation the ticket is holding. It is holding one only if it
          // stopped with something to come back to — a question it asked, or a
          // workbench that stopped underneath it — and only if what moved it here was
          // one of the two moves that goes back to that run: `movedOn` in ticket.ts
          // drops the session on every other one. So the rule can be that single
          // fact, rather than a list of the reasons it might be true.
          //
          // Never while a merge is waiting, though: a resumed run is not given a
          // brief, and the merge is in the brief.
          resume: conflict === undefined ? (ticket.session ?? undefined) : undefined,
          // A stage announcing which step it has reached is recorded as a fact of its
          // own, so the board shows progress without anyone reading prose. Done here
          // rather than in a runner: it is what a stage *said* that counts, so every
          // runner gets it, and the fake one exercises the same path.
          emit: (body) => {
            store.append(ticket.id, body);
            if (body.type !== 'agent_said') return;
            const index = readStep(body.text);
            if (index !== undefined)
              store.append(ticket.id, { type: 'step_reached', runId, index });
          },
          signal: abort.signal,
        });
      } catch (error) {
        // A crash is not a rejection: the ticket parks rather than looping back to plan.
        // Nothing is charged for it, because a runner that gets here died rather than
        // answered and there is no figure to charge: the real one reports its failures,
        // with what they spent, rather than throwing them.
        result = { outcome: 'failed', summary: describe(error) };
      } finally {
        aborts.delete(ticket.id);
      }

      // The run did not end, it was ended: `interrupt` aborted it, and whatever the
      // runner said on the way out is a description of being stopped rather than of
      // anything that went wrong. Recorded as `interrupted` — not `failed` — because
      // that is what keeps the conversation and offers to carry the stage on instead
      // of buying it again, the same distinction `reconcile` draws for a workbench
      // that died mid-stage. Nothing is committed: the tree is half-written.
      if (broken.delete(ticket.id)) {
        result = {
          outcome: 'interrupted',
          summary: 'stopped by the manager',
          costUsd: result.costUsd,
          // Whatever conversation the run got as far as naming. Read back from the
          // store, because `session_started` is emitted by the run rather than
          // returned by it, and a run stopped mid-flight returns very little.
          sessionId: result.sessionId ?? store.ticket(ticket.id).session ?? undefined,
        };
      }

      // The far end of the merge handed over at the start. A run that finished with
      // any of it still conflicted parks the ticket, and nothing is committed:
      // `commit` stages everything it finds, so an unresolved merge would put
      // conflict markers on the branch as though they were the stage's work.
      if (conflict !== undefined && result.outcome === 'completed') {
        const left = await deps.workspace.unresolved(ticket.id, conflict.paths);
        if (left.length > 0) {
          result = {
            outcome: 'blocked',
            // The run's own summary is kept: what it did is still what it did, and
            // whoever answers this needs it as much as they need the unfinished merge.
            summary: `${left.join(', ')} are still conflicted: ${result.summary}`,
            costUsd: result.costUsd,
          };
        }
      }

      // Commit before announcing the stage finished: the next stage's diff is
      // taken against the base branch, so uncommitted work is invisible to it.
      if (result.outcome === 'completed') {
        try {
          commit = await deps.workspace.commit(ticket, `${stage}: ${ticket.title} (${ticket.id})`);
          // The merge handed over at the start is on the branch now, so this is where
          // the base it brought in is recorded — `conflicted` deliberately moves
          // nothing, because until this commit there was nothing to move. Without it
          // the ticket keeps the base it was cut from, and every later diff is taken
          // from there: the whole of the merged-in work read as this ticket's own.
          if (conflict !== undefined && commit !== null) {
            store.append(ticket.id, {
              type: 'refreshed',
              base: conflict.base,
              commit,
              carrying: carriedWork(ticket, store.tickets(), []),
            });
          }
        } catch (error) {
          // The run still cost what it cost, whatever happened afterwards.
          result = {
            outcome: 'failed',
            summary: `could not commit: ${describe(error)}`,
            costUsd: result.costUsd,
          };
        }
      }

      // The checks the merge kept this run from starting with, asked now that it is
      // resolved and committed. Nothing else will ask: the next action is `open_pr`,
      // whose refresh finds a branch already up to date and runs them only when
      // something merged — so the change most likely to break the suite would be the
      // one offered without it ever being run.
      if (stage === 'verify' && conflict !== undefined && result.outcome === 'completed') {
        const results = await deps.checks(worktree);
        if (results.length > 0) store.append(ticket.id, { type: 'checks_run', runId, results });

        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          const why = failed.map((f) => `\`${f.command}\` failed:\n${f.output}`).join('\n\n');
          // Back to planning, the way a failure found before the run already goes. What
          // the run itself objected to is kept alongside: both are reasons it is going
          // back, and the next plan has to answer both.
          result = { ...result, rejected: result.rejected ? `${result.rejected}\n\n${why}` : why };
        }
      }

      // One rejected credential means every other ticket would be refused too. Stop,
      // rather than working through the queue burning a stage on each of them. The
      // failure can arrive thrown or returned, so it is recognised here, where both
      // have already become the same thing.
      // Recording it is enough: the next tick sees it and announces the pause once,
      // with the same wording as every other reason the board is not working.
      if (result.outcome === 'failed' && isCredentialRejection(result.summary) && !rejection) {
        rejection = result.summary;
      }

      if (result.question) {
        store.append(ticket.id, {
          type: 'question_asked',
          runId,
          question: result.question.question,
          reasoning: result.question.reasoning,
        });
      }

      store.append(ticket.id, {
        type: 'stage_finished',
        runId,
        outcome: result.outcome,
        summary: result.summary,
        rejected: result.rejected,
        changes: result.changes,
        costUsd: result.costUsd,
        commit: commit ?? undefined,
        scale: result.scale,
        steps: result.steps,
        completionCriteria: result.completionCriteria,
        later: result.later,
        sessionId: result.sessionId,
      });
    } finally {
      // Whatever ends this run — returning, or a refresh, a check or an append
      // throwing on the way — ends its claim on being stoppable. A name left behind
      // in either of these belongs to a run that is over: `interrupt` would report
      // abandoning it, and the next stage under the same id would find itself
      // already broken and be recorded `interrupted` before it began.
      if (aborts.get(ticket.id) === abort) aborts.delete(ticket.id);
      broken.delete(ticket.id);
    }
  }

  /** Guards against a rule that keeps finding work forever. */
  const SETTLE_LIMIT = 500;

  return {
    tick,

    interrupt() {
      // Named before they are aborted, so `doStage` finds the name however fast the
      // abort comes back. The same wire a cancellation travels; what differs is what
      // the stopped run is recorded as.
      const ids = [...aborts.keys()];
      for (const id of ids) {
        broken.add(id);
        aborts.get(id)?.abort();
      }
      return ids;
    },

    async idle() {
      for (let i = 0; i < SETTLE_LIMIT; i++) {
        const before = store.eventCount();
        const active = await tick({ poll: true });
        await Promise.allSettled([...inFlight.values()]);

        // Settled when a pass found nothing happening, recorded nothing, and left
        // nothing running. Asking `tick` what it saw is the only reliable test:
        // whether an action may start depends on capacity and on credentials, and
        // re-deriving that here means keeping two copies of the same rule in step.
        if (!active && inFlight.size === 0 && store.eventCount() === before) return;
      }
      throw new Error(`orchestrator still busy after ${SETTLE_LIMIT} passes`);
    },

    start() {
      stopped = false;
      // Every flow is driven by an appended event. The timer exists only for the
      // one thing that has no event to wait for: a pull request awaiting a human.
      listening = true;
      timer = setInterval(() => void tick({ poll: true }), pollMs);
      timer.unref?.();
      void tick();
    },

    async stop() {
      stopped = true;
      listening = false;
      unsubscribe();
      if (timer) clearInterval(timer);
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
