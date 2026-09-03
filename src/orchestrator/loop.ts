import { randomUUID } from 'node:crypto';

import type { CheckRun, EventBody, Refreshed, RunOutcome, Scale, Stage } from '../domain/events.ts';
import { ended, type Ticket } from '../domain/ticket.ts';
import { awaitedWork, carriedWork, heldBy, nextAction, type Action } from '../domain/rules.ts';
import type { Store } from '../store/store.ts';
import { isCredentialRejection, refused, type Credentials } from '../run/credentials.ts';
import { readStep } from '../run/protocol.ts';

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
  /**
   * The merge gate: the ticket merging, and any that arrived while it was. One
   * merge at a time, the pass over every other open pull request included.
   *
   * A merge lands on the base and then brings that base into every other offered
   * branch, one at a time. Two at once put two passes in the same worktrees, and no
   * click is needed for that — a poll that finds three pull requests merged on
   * github.com starts three. A set rather than a flag because insertion order names
   * the holder, which is what a ticket waiting is told it is waiting for.
   */
  const mergeGate = new Set<string>();
  let mergeChain: Promise<unknown> = Promise.resolve();
  /** Tickets already told they are waiting, so it is said once and not once a tick. */
  const toldTheyWait = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let listening = false;
  /** So the credential state is announced when it changes, not on every tick. */
  let wasOk = true;
  /** The same, for the code host: an outage is said once, not once per poll. */
  let hostAnswering = true;
  /**
   * Set when the model service refuses the credential we have. Sticky on purpose:
   * checking that a credential is *present* cannot tell you it is *accepted*, and
   * the only authority on that is a real call. Once one comes back rejected, no
   * amount of re-checking locally will change the answer — the credential itself
   * has to change, and for an environment variable that means a restart.
   */
  let rejection: string | undefined;

  // Subscribed from the moment the orchestrator exists, not from start(), because a
  // cancellation has to reach a running stage whether or not the timer is going.
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'cancelled') aborts.get(event.ticketId)?.abort();
    if (listening) void tick();
  });

  /**
   * Queues `fn` behind whatever else is merging, and runs it with nothing else.
   *
   * The gate is taken here rather than when the chain reaches `fn`, so a tick that
   * runs in between sees the queue and leaves the ticket alone. What fails is the
   * caller's to answer — the chain swallows it, because the next merge in the queue
   * is not the one that failed and must still be let through.
   */
  function runMerge<T>(id: string, fn: () => Promise<T>): Promise<T> {
    mergeGate.add(id);
    toldTheyWait.delete(id);
    const next = mergeChain.then(fn);
    const done = () => {
      mergeGate.delete(id);
    };
    mergeChain = next.then(done, done);
    return next;
  }

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
   * The manager's answer, or null when the code host could not be asked.
   *
   * Asking is a read, and the timer asks again thirty seconds later, so a failure
   * is a blip rather than a decision: it is said out loud and nothing is recorded.
   * Recording it would block the ticket, which spends a person on the network —
   * one outage parked two tickets a tenth of a second apart, and answering a
   * blocked ticket bought a verify stage that had already passed.
   *
   * Everything else that can fail here is a decision and still blocks: a stage
   * that died, a push that was refused, a base that will not merge.
   */
  async function verdictOf(ticket: Ticket): Promise<Verdict | null> {
    try {
      const verdict = await deps.host.verdict(ticket);
      if (!hostAnswering) {
        hostAnswering = true;
        deps.announce('the code host is answering again — reading verdicts');
      }
      return verdict;
    } catch (error) {
      if (hostAnswering) {
        hostAnswering = false;
        deps.announce(
          `⚠️  cannot read verdicts: ${describe(error)}\n` +
            'Still asking. Nothing is lost, and no ticket is stopped by this.',
        );
      }
      return null;
    }
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
      if (action.kind === 'merge_pr' && mergeGate.size > 0) {
        if (!toldTheyWait.has(ticket.id)) {
          toldTheyWait.add(ticket.id);
          deps.announce(`${ticket.id} is queued behind ${[...mergeGate][0]}'s merge`);
        }
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
          await doOpenPr(ticket);
          break;
        case 'poll_verdict':
          await doPollVerdict(ticket);
          break;
        case 'merge_pr':
          await doMergePr(ticket);
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

  /**
   * Brings the base in before a stage runs, rather than only when the work is
   * offered. A branch that goes stale for a whole implement and a whole verify
   * discovers it at the end, when the agent that could have resolved the clash in
   * minutes has finished and the ticket parks for a person to pick up a day later.
   *
   * Nothing blocks here, and the standing checks are not run: this is the start of
   * a stage, and the stage is what puts things right. A clean merge is the ordinary
   * answer and only records the commit it made. A conflict is left on disk and
   * handed to the run, which cannot finish until it is resolved.
   *
   * @returns the merge the stage is being asked to finish, if there is one.
   */
  async function refreshForStage(
    ticket: Ticket,
    stage: Stage,
    runId: string,
  ): Promise<{ base: string; paths: string[] } | undefined> {
    // Only the stages that can write. Plan and review are granted no editing tools
    // at all, so a conflict handed to one of them could only sit there unresolved.
    if (stage !== 'implement' && stage !== 'verify') return undefined;

    // The base and nothing else: the work this ticket waited for is brought in by
    // `takeAwaitedWork`, before the stage starts, and a dependency's conflict is not
    // one to hand a stage — it belongs to the manager who chose the dependency.
    const result = await deps.workspace.refresh(ticket.id, [], true);
    if (result.kind === 'up-to-date') return undefined;

    if (result.kind === 'merged') {
      store.append(ticket.id, {
        type: 'refreshed',
        base: result.base,
        commit: result.commit,
        // Nothing was taken here — only the base came in — but what the branch was
        // already standing on is still in it, and a `refreshed` that says otherwise
        // is what lets the base move onto a commit that has not got it.
        carrying: carriedWork(ticket, store.tickets(), []),
      });
      return undefined;
    }

    // Nothing left on disk to finish: the merge failed rather than conflicted — an
    // index that was busy, a checkout that could not be written — and `refresh` has
    // already undone it. The stage runs against the base it had, and the offer will
    // find it again. Asked of the merge rather than of the paths, because a run that
    // stopped after staging its resolution leaves one with no unmerged paths at all,
    // and that merge still has to be finished and recorded by whoever takes it on.
    if (!result.merging) return undefined;

    store.append(ticket.id, { type: 'conflicted', runId, base: result.base, paths: result.paths });
    return { base: result.base, paths: result.paths };
  }

  async function doStage(ticket: Ticket, stage: Stage): Promise<void> {
    const { path: worktree, scratch } = await prepare(ticket);
    const runId = randomUUID();

    store.append(ticket.id, { type: 'stage_started', stage, runId });

    const conflict = await refreshForStage(ticket, stage, runId);
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
      if (passed === null) return; // rejected, and no agent was asked
      checks = passed;
    }

    const abort = new AbortController();
    aborts.set(ticket.id, abort);

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
          if (index !== undefined) store.append(ticket.id, { type: 'step_reached', runId, index });
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
  }

  /**
   * Offering the ticket's work. Safe to reach twice, and not by skipping the host
   * when the ticket already has a URL: what the host does first is push, and a
   * ticket back here has commits the pull request has never seen. It is the host
   * that reuses the pull request the branch already has.
   */
  async function doOpenPr(ticket: Ticket): Promise<void> {
    // The workspace has to exist to be offered, even though the host finds it itself.
    const { path: worktree } = await prepare(ticket);
    // Offered against the code that exists, not the code that did when the branch
    // was cut. A ticket that cannot be brought up to date is not offered at all.
    if (!(await refresh(ticket, worktree))) return;
    const url = await deps.host.openPr(ticket);
    store.append(ticket.id, { type: 'pr_opened', url });
  }

  /** The branches of the offered work this ticket waited for. See `awaitedWork`. */
  function awaitedBranches(ticket: Ticket): string[] {
    return awaitedWork(ticket, store.tickets()).map((t) => t.branch);
  }

  /**
   * Brings the base — and the work this ticket waited for, which is offered and so
   * is not in the base yet — into a ticket's branch, and says whether the ticket
   * may carry on. A clean branch is the ordinary answer: nothing merged, nothing
   * recorded, nothing re-run, nothing spent.
   *
   * When something did merge, the standing checks decide. They are the whole point
   * of refreshing — a merge git can do silently is exactly the change that breaks
   * a ticket against work that landed while it was busy, and running them here is
   * how that is found on the ticket rather than by a person at merge time.
   *
   * A conflict and a failure both park the ticket rather than starting anything: the
   * work stands, and what to do about it is a decision — ship it, put it right, or
   * stop it — rather than a stage. What a conflict does leave behind is whatever
   * merged before it, so that is recorded first: the branch has moved, and a record
   * that says otherwise is what measures a dependency's change as this ticket's.
   */
  async function refresh(ticket: Ticket, worktree: string): Promise<boolean> {
    const result = await deps.workspace.refresh(ticket.id, awaitedBranches(ticket));
    if (result.kind === 'up-to-date') return true;

    // What came in with the base is recorded along with it, because a branch
    // standing on work the base has not got cannot be measured from the base: see
    // `refreshed` in events.ts. Written whichever way the merge went — a conflict
    // leaves everything that merged before it standing, and the branch's record has
    // to say where the branch is rather than where it was.
    const took = result.merged.filter((ref) => ref !== result.base);
    if (result.merged.length > 0) {
      store.append(ticket.id, {
        type: 'refreshed',
        base: result.base,
        commit: result.commit,
        took,
        // Everything the base still has not got, not only what came in now: a
        // dependency sent back for changes stops being offered without its work
        // reaching the base, and the reducer is what decides whether the base may
        // move onto this one.
        carrying: carriedWork(ticket, store.tickets(), took),
      });
    }

    if (result.kind === 'conflicted') {
      store.append(ticket.id, {
        type: 'blocked',
        reason:
          `this branch conflicts with ${describeRef(result.with, result.base)}:\n` +
          result.paths.map((p) => `  ${p}`).join('\n'),
        // The same paths as data, so the panel can list them and offer the way out
        // rather than leaving them buried in a paragraph.
        conflicts: result.paths,
      });
      return false;
    }

    const failed = (await deps.checks(worktree)).filter((r) => !r.ok);
    if (failed.length === 0) return true;

    store.append(ticket.id, {
      type: 'blocked',
      reason:
        `the base has moved on to ${result.base.slice(0, 8)}, and against it ` +
        `${failed.length} standing check(s) fail:\n\n` +
        failed.map((f) => `\`${f.command}\` failed:\n${f.output}`).join('\n\n'),
    });
    return false;
  }

  /**
   * A merge moves the base under every other pull request that is standing, and
   * they find out one at a time as somebody tries to merge them. So they are told:
   * each takes the new base and re-runs its checks, and a clash surfaces on the
   * ticket that has it, while the ticket is still the thing being worked on.
   *
   * The ones still being built are told too, but not here and not the same way:
   * they take the base at the start of their next stage, and a clash there is
   * given to the agent that is about to work on the files rather than parking the
   * ticket. Nothing is pushed for them, so there is nothing to do between stages.
   */
  async function refreshOffered(merged: Ticket): Promise<void> {
    // Ended tickets are told nothing. Cancelling does not take the offer back — see
    // `awaitedWork` for why it must not — so a cancelled ticket still reads as
    // offered, and without this every later merge brought it back up to the base,
    // found the conflicts nobody is going to resolve, and blocked it: a ticket the
    // manager stopped, back on the board hours after they stopped it.
    const standing = store
      .tickets()
      .filter(
        (t) => t.id !== merged.id && t.offered && !ended(t) && !t.running && !inFlight.has(t.id),
      );

    for (const ticket of standing) {
      try {
        // A pull request the manager has already answered is waiting on nobody: it
        // is not refreshed, because pushing a merge to it would be a commit made
        // for reasons that have nothing to do with the answer, and `readVerdict`
        // reads a branch that has moved past a change request as having addressed
        // it. The next poll picks the answer up.
        const answered = await verdictOf(ticket);
        if (answered === null || answered.kind !== 'pending') continue;
        const { path: worktree } = await prepare(ticket);
        await refresh(ticket, worktree);
      } catch (error) {
        store.append(ticket.id, { type: 'blocked', reason: describe(error) });
      }
    }
  }

  async function doPollVerdict(ticket: Ticket): Promise<void> {
    const verdict = await verdictOf(ticket);
    if (verdict === null || verdict.kind === 'pending') return;

    store.append(ticket.id, {
      type: 'verdict',
      verdict: verdict.kind,
      reason: verdict.kind === 'rejected' ? verdict.reason : undefined,
    });

    // Behind the same gate as a merge asked for here: one poll can find three pull
    // requests merged on github.com, and three passes over the same worktrees at
    // once is what blocked t9 four times in 320ms.
    if (verdict.kind === 'accepted') await runMerge(ticket.id, () => accepted(ticket));
  }

  /**
   * The manager said merge it, here rather than on the code host.
   *
   * The base goes in first, and a clash stops the whole thing: nothing is merged,
   * the branch is untouched, and the ticket parks with the files named. That is
   * what `refresh` already does for a ticket being offered, and a merge is the one
   * moment the answer matters most — the alternative is finding out from the host
   * that the merge was refused, which says less and leaves it half-done.
   *
   * The verdict is recorded here rather than left for the next poll to read off
   * the host: the ticket leaves `awaiting_verdict` at once, so a second tick
   * cannot arrive and merge what has already been merged.
   *
   * All of it behind the merge gate, the pass over the other branches included: see
   * `runMerge` for what two of those at once does.
   */
  async function doMergePr(ticket: Ticket): Promise<void> {
    await runMerge(ticket.id, async () => {
      const { path: worktree } = await prepare(ticket);
      if (!(await refresh(ticket, worktree))) return;

      await deps.host.merge(ticket);
      store.append(ticket.id, { type: 'verdict', verdict: 'accepted' });
      await accepted(ticket);
    });
  }

  /** What follows work being accepted, however the acceptance was arrived at. */
  async function accepted(ticket: Ticket): Promise<void> {
    // Tidying up is not the ticket's business: a directory left behind is untidy,
    // not broken, and must not turn an accepted ticket into a blocked one.
    await deps.workspace.discard(ticket.id).catch(() => {});
    // The base has moved. Everything else standing is now offered against a base
    // that no longer exists, which is the whole reason conflicts turn up at all.
    await refreshOffered(ticket);
  }

  /** Makes the workspace, recording where the branch was cut from the first time. */
  async function prepare(ticket: Ticket): Promise<{ path: string; scratch: string }> {
    const { path, scratch, base } = await deps.workspace.prepare(
      ticket.id,
      // A ticket that continues another starts from that one's branch, so its
      // work is on disk here rather than stranded where nothing can read it.
      ticket.continues === null ? undefined : `wb/${ticket.continues}`,
    );
    if (base !== null) {
      store.append(ticket.id, { type: 'branched', branch: ticket.branch, base });
      await takeAwaitedWork(ticket);
    }
    return { path, scratch };
  }

  /**
   * Puts the work this ticket waited for into the branch just cut for it.
   *
   * A ticket is released the moment what it waits for is *offered*, which is the
   * right moment — but the base does not have that work in it yet, and by
   * definition will not until a person merges it. So the branch is cut from the
   * base, as every branch is, and then the offered work is merged in: the commit
   * this ticket needs is the base with all of its dependencies on it, and nowhere
   * else in the world is there one. Without this the wait is honoured in name and
   * defeated in fact — the ticket starts at the right time, on the wrong code.
   *
   * Only where the branch is cut, so a ticket pays for this once. The standing
   * checks are not run: they judge a ticket's own work against a base that moved,
   * and there is no work here yet.
   *
   * A conflict blocks the ticket — `perform` turns the throw into `blocked`, and
   * this is reached before `stage_started`, so two dependencies that will not sit in
   * one tree stop it at the cheapest moment there is. Whatever merged before the
   * conflict is recorded first: it is on the branch, and the branch's record has to
   * say what the branch is.
   */
  async function takeAwaitedWork(ticket: Ticket): Promise<void> {
    const branches = awaitedBranches(ticket);
    if (branches.length === 0) return;

    const result = await deps.workspace.refresh(ticket.id, branches);
    if (result.kind === 'up-to-date') return;

    // Recorded against the merge rather than the commit the branch was cut from,
    // because that is what this ticket's own work is now measured from: `diff` reads
    // `base...HEAD`, so leaving the base behind the dependencies hands every stage —
    // and then the reviewer — their work as though this ticket had written it. The
    // failure `refreshed` moves the base to prevent, arriving by the other door.
    //
    // What merged, not what was asked for: a conflict leaves the merges before it
    // standing, and a blocked ticket whose base is still the commit it was cut from
    // hands the stage that follows the manager's answer exactly that whole change.
    const took = result.merged.filter((ref) => ref !== result.base);
    if (result.merged.length > 0) {
      store.append(ticket.id, {
        type: 'refreshed',
        base: result.commit,
        commit: result.commit,
        took,
        carrying: carriedWork(ticket, store.tickets(), took),
      });
    }

    if (result.kind === 'conflicted') {
      throw new Error(
        `this branch cannot take ${describeRef(result.with, result.base)}:\n` +
          result.paths.map((p) => `  ${p}`).join('\n'),
      );
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What would not merge, said so a person can act on it: the base is a commit and
 * is worth naming as one, and anything else is a ticket's branch, which says which
 * ticket without anybody having to look a sha up.
 */
function describeRef(ref: string, base: string): string {
  return ref === base
    ? `${base.slice(0, 8)}, which the base has moved on to`
    : `${ref}, whose work it waits for`;
}
