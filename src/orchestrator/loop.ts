import { randomUUID } from 'node:crypto';

import type { CheckRun, EventBody, Refreshed, Scale, Stage } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { awaitedWork, carriedWork, heldBy, nextAction, type Action } from '../domain/rules.ts';
import type { Store } from '../store/store.ts';
import { isCredentialRejection, refused, type Credentials } from '../run/credentials.ts';
import { readStep } from '../run/protocol.ts';

/** An action that has something to carry out — everything except waiting. */
type Doable = Exclude<Action, { kind: 'wait' }>;

/** What a stage run reports back. The orchestrator turns this into events. */
export type RunResult = {
  outcome: 'completed' | 'blocked' | 'failed';
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
  doneWhen?: string[];
  /** Improvements worth a later ticket, which are not this one's job. */
  later?: string[];
  /** Set when the agent asked the manager something. */
  question?: { question: string; reasoning: string };
  /**
   * The conversation this run was, kept only when it stopped with something left
   * to say. Answering the question resumes it rather than starting again.
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
   * The conversation to pick back up, when this run is answering a question that
   * stopped an earlier one. Best-effort: a runner that cannot resume must start
   * the stage afresh rather than fail.
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
  ) => Promise<Refreshed>;
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
 * @returns the tickets that were picked up mid-stage.
 */
export function reconcile(store: Store): string[] {
  const interrupted = store.tickets().filter((t) => t.running);

  for (const ticket of interrupted) {
    store.append(ticket.id, {
      type: 'stage_finished',
      runId: 'interrupted',
      outcome: 'failed',
      summary: 'the workbench stopped while this stage was running',
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
    const { path: worktree, scratch } = await prepare(ticket);
    const runId = randomUUID();

    store.append(ticket.id, { type: 'stage_started', stage, runId });

    let checks: CheckRun[] | undefined;
    if (stage === 'verify') {
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
        // Only when there is an answer to carry in. A session with nothing new to
        // say to it is not worth resuming.
        resume: ticket.answer !== null ? (ticket.session ?? undefined) : undefined,
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

    // Commit before announcing the stage finished: the next stage's diff is
    // taken against the base branch, so uncommitted work is invisible to it.
    if (result.outcome === 'completed') {
      try {
        commit = await deps.workspace.commit(ticket, `${stage}: ${ticket.title} (${ticket.id})`);
      } catch (error) {
        // The run still cost what it cost, whatever happened afterwards.
        result = {
          outcome: 'failed',
          summary: `could not commit: ${describe(error)}`,
          costUsd: result.costUsd,
        };
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
      doneWhen: result.doneWhen,
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
   * Not the ones still being built. They refresh when they are offered, which is
   * soon enough and costs nothing in the meantime.
   */
  async function refreshOffered(merged: Ticket): Promise<void> {
    const standing = store
      .tickets()
      .filter((t) => t.id !== merged.id && t.offered && !t.running && !inFlight.has(t.id));

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

    if (verdict.kind === 'accepted') {
      // Tidying up is not the ticket's business: a directory left behind is untidy,
      // not broken, and must not turn an accepted ticket into a blocked one.
      await deps.workspace.discard(ticket.id).catch(() => {});
      // The base has moved. Everything else standing is now offered against a base
      // that no longer exists, which is the whole reason conflicts turn up at all.
      await refreshOffered(ticket);
    }
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
