import { ended, type Ticket } from '../domain/ticket.ts';
import { carriedWork } from '../domain/rules.ts';
import type { Branch } from './branch.ts';
import { describe, describeRef } from './describe.ts';
import type { Deps, RunResult, Verdict } from './loop.ts';

/** Offering a ticket's work, and everything that follows the manager's answer. */
export type Merging = {
  openPr: (ticket: Ticket) => Promise<void>;
  pollVerdict: (ticket: Ticket) => Promise<void>;
  mergePr: (ticket: Ticket) => Promise<void>;
  /** Whether a merge holds the gate, so another one may not start. */
  merging: () => boolean;
  /** Says once that this ticket is queued behind the merge that holds the gate. */
  tellQueued: (ticket: Ticket) => void;
};

export function createMerging({
  deps,
  branch,
  busy,
  settleOffered,
}: {
  deps: Deps;
  branch: Branch;
  /** Whether this ticket's work is already in flight in this process. */
  busy: (ticketId: string) => boolean;
  /**
   * Runs implement over a merge left in an offered ticket's worktree, and says how
   * it went. One run: what it does not settle, the manager is asked about.
   */
  settleOffered: (ticket: Ticket) => Promise<RunResult>;
}): Merging {
  const { store } = deps;

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
  /** So a code host outage is said once, not once per poll. */
  let hostAnswering = true;

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
   * Offering the ticket's work. Safe to reach twice, and not by skipping the host
   * when the ticket already has a URL: what the host does first is push, and a
   * ticket back here has commits the pull request has never seen. It is the host
   * that reuses the pull request the branch already has.
   */
  async function doOpenPr(ticket: Ticket): Promise<void> {
    // The workspace has to exist to be offered, even though the host finds it itself.
    const { path: worktree } = await branch.prepare(ticket);
    // Offered against the code that exists, not the code that did when the branch
    // was cut. A ticket that cannot be brought up to date is not offered at all.
    if (!(await refresh(ticket, worktree))) return;
    const url = await deps.host.openPr(ticket);
    store.append(ticket.id, { type: 'pr_opened', url });
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
   * A failure parks the ticket rather than starting anything: the work stands, and
   * what to do about a base that breaks it is a decision — ship it, put it right, or
   * stop it — rather than a stage. A clash with the base is the one exception, and
   * only where `settle` says a stage may be given the merge: see the conflicted
   * branch below. What a conflict does leave behind is whatever merged before it, so
   * that is recorded first: the branch has moved, and a record that says otherwise is
   * what measures a dependency's change as this ticket's.
   *
   * @param settle whether a clash with the base may be handed to an implement run
   *   rather than to the manager. Only the pass over the offered branches says yes.
   */
  async function refresh(ticket: Ticket, worktree: string, settle = false): Promise<boolean> {
    const result = await deps.workspace.refresh(
      ticket.id,
      branch.awaitedBranches(ticket),
      // Left on disk only where there is something that will finish it.
      settle,
    );

    if (result.kind !== 'up-to-date') {
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
        // A clash with the base on a branch that is offered is the agents' to settle:
        // the merge is left where it is and an implement run is asked to finish it,
        // exactly as the start of a stage already does. The manager's click did not
        // say anything a run could not work out for itself.
        //
        // With the base, and nothing else: a clash with work this ticket waited for
        // belongs to whoever chose the dependency. And only where the merge is still
        // on disk — one that failed rather than conflicted has nothing to resolve.
        const attempt =
          settle && result.merging && result.with === result.base
            ? await settleOffered(ticket)
            : undefined;

        if (attempt?.outcome === 'completed') {
          // Offered again, which pushes the resolution to the pull request already
          // standing and runs the refresh and the checks against a branch that is now
          // up to date. From the store: the settling run moved the base and made a
          // commit, and the ticket in hand still says otherwise.
          await doOpenPr(store.ticket(ticket.id));
          return false;
        }

        // Nothing landed, so nothing is kept: whatever the attempt left goes, and the
        // manager is asked about the work as it was offered. Also for a merge kept for
        // a settle that was never going to happen — a dependency's clash.
        if (result.merging) await deps.workspace.abandonMerge(ticket.id);

        store.append(ticket.id, {
          type: 'blocked',
          reason:
            `this branch conflicts with ${describeRef(result.with, result.base)}:\n` +
            result.paths.map((p) => `  ${p}`).join('\n') +
            (attempt === undefined
              ? ''
              : `\n\nA resolution was tried and did not land: ${attempt.summary}`),
          // The same paths as data, so the panel can list them and offer the way out
          // rather than leaving them buried in a paragraph.
          conflicts: result.paths,
        });
        return false;
      }
    }

    // What the branch deletes of what the base added while it was being built.
    // Asked after the merge and never before it: before it, every file the base has
    // just gained is missing from the branch and every ticket would park. An
    // up-to-date branch is asked too — a resolution reverts just as well as a merge
    // does, and it leaves the base exactly where it was.
    const removed = await deps.workspace.removedFromBase(ticket.id, ticket.base ?? undefined);
    if (removed.length > 0) {
      store.append(ticket.id, {
        type: 'blocked',
        reason:
          'this branch deletes files the base added while it was being built:\n' +
          removed.map((p) => `  ${p}`).join('\n') +
          '\n\nThey are the base’s work, not this ticket’s, and the answer is ' +
          'almost always to put them back as the base has them.',
      });
      return false;
    }

    if (result.kind === 'up-to-date') return true;

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
   * each takes the new base and re-runs its checks, and a clash is given to an
   * implement run — the ticket is the thing being worked on, and resolving one is
   * work rather than a decision.
   *
   * The ones still being built are told too, but not here: they take the base at
   * the start of their next stage, and the same run resolves it as part of what it
   * was going to do anyway. Nothing is pushed for them, so there is nothing to do
   * between stages.
   */
  async function refreshOffered(merged: Ticket): Promise<void> {
    // Ended tickets are told nothing. Cancelling does not take the offer back — see
    // `awaitedWork` for why it must not — so a cancelled ticket still reads as
    // offered, and without this every later merge brought it back up to the base,
    // found the conflicts nobody is going to resolve, and blocked it: a ticket the
    // manager stopped, back on the board hours after they stopped it.
    const standing = store
      .tickets()
      .filter((t) => t.id !== merged.id && t.offered && !ended(t) && !t.running && !busy(t.id));

    for (const ticket of standing) {
      try {
        // A pull request the manager has already answered is waiting on nobody: it
        // is not refreshed, because pushing a merge to it would be a commit made
        // for reasons that have nothing to do with the answer, and `readVerdict`
        // reads a branch that has moved past a change request as having addressed
        // it. The next poll picks the answer up.
        const answered = await verdictOf(ticket);
        if (answered === null || answered.kind !== 'pending') continue;
        const { path: worktree } = await branch.prepare(ticket);
        await refresh(ticket, worktree, true);
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
      const { path: worktree } = await branch.prepare(ticket);
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

  return {
    openPr: doOpenPr,
    pollVerdict: doPollVerdict,
    mergePr: doMergePr,
    merging: () => mergeGate.size > 0,

    tellQueued(ticket) {
      if (toldTheyWait.has(ticket.id)) return;
      toldTheyWait.add(ticket.id);
      deps.announce(`${ticket.id} is queued behind ${[...mergeGate][0]}'s merge`);
    },
  };
}
