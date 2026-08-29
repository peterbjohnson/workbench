import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CodeHost, Verdict } from '../orchestrator/loop.ts';
import { worktreeFor, type GitConfig, type Worktree } from '../git/worktree.ts';

const run = promisify(execFile);

/**
 * GitHub as the orchestrator's code host. The only place that knows a ticket is
 * offered as a pull request, and the only place that writes what one says.
 */
export function githubHost(cfg: GitConfig): CodeHost {
  return {
    openPr: (ticket) =>
      openPr(worktreeFor(cfg, ticket.id), {
        title: ticket.title,
        body: `${ticket.body}\n\n---\nWorkbench ticket ${ticket.id}.`,
        base: cfg.base,
      }),
    verdict: async (ticket) => {
      if (!ticket.prUrl) throw new Error('no pull request to read a verdict from');
      return verdict(ticket.prUrl, cfg.repoRoot);
    },
    merge: async (ticket) => {
      if (!ticket.prUrl) throw new Error('no pull request to merge');
      return mergePr(worktreeFor(cfg, ticket.id), ticket.prUrl);
    },
  };
}

/** What `gh pr view --json state,reviews,commits` gives back, as far as we care. */
export type PrState = {
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string;
  reviews?: { state: string; body?: string; submittedAt?: string }[];
  commits?: { committedDate?: string }[];
};

/**
 * The manager accepts by merging and rejects by requesting changes. Translated
 * here into the workbench's own words, so nothing above this file knows what
 * GitHub calls things.
 */
export function readVerdict(pr: PrState): Verdict {
  if (pr.state === 'MERGED') return { kind: 'accepted' };

  // A change request the branch has moved past has been addressed: GitHub leaves the
  // review standing until someone looks again, but the work it objected to is gone.
  // Read as a live rejection it would send a reworked ticket round the loop the
  // moment it re-offered itself, for ever, over an objection already dealt with.
  // Dates missing either side means saying nothing, which is the standing review.
  const head = (pr.commits ?? [])
    .map((c) => c.committedDate ?? '')
    .sort()
    .at(-1);
  const standing = (r: { submittedAt?: string }) =>
    !head || !r.submittedAt || r.submittedAt >= head;

  const latestChangeRequest = [...(pr.reviews ?? [])]
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .filter(standing)
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))
    .at(-1);

  if (latestChangeRequest) {
    const body = latestChangeRequest.body?.trim();
    return { kind: 'rejected', reason: body || 'changes requested, with no comment' };
  }

  if (pr.state === 'CLOSED') {
    return { kind: 'rejected', reason: 'the pull request was closed without merging' };
  }

  return { kind: 'pending' };
}

/**
 * Pushes the branch and opens the pull request. Returns its URL.
 *
 * Offering the same branch twice is not an error, and must not be: a ticket
 * reworked after a rejection comes back here, and GitHub keeps one pull request
 * per branch. The push is what carries the rework across either way — asking
 * before creating is all that makes the second offer mean the first one again,
 * rather than `gh pr create` refusing and the ticket blocking on it.
 */
export async function openPr(
  wt: Worktree,
  opts: { title: string; body: string; base: string },
): Promise<string> {
  await run('git', ['push', '-u', 'origin', wt.branch], { cwd: wt.path });

  const existing = await prFor(wt);
  if (existing !== null) return existing;

  const { stdout } = await run(
    'gh',
    [
      'pr',
      'create',
      '--head',
      wt.branch,
      '--base',
      opts.base,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ],
    { cwd: wt.path },
  );

  const url = stdout.trim().split('\n').at(-1) ?? '';
  if (!url.startsWith('http')) {
    throw new Error(`could not read a pull request URL from: ${stdout.trim()}`);
  }
  return url;
}

/**
 * The pull request to offer this branch on again, out of what `gh pr view` says
 * about the one it has. Its own function, like `mergeArgs`, so the decision can be
 * tested without a network.
 *
 * A merged one is not one to reuse. A ticket sent back to be tweaked comes through
 * here on the branch its work already merged from — reusing that pull request
 * would have the workbench record it, poll it, read `MERGED` as an acceptance and
 * mark the ticket done with the tweak never merged.
 *
 * `OPEN` and `CLOSED` are reused, and must be: a ticket reworked after an
 * objection has to come back to the pull request that objection was written on.
 */
export function reusablePr(stdout: string): string | null {
  const pr = JSON.parse(stdout) as { url?: string; state?: string };
  return pr.state === 'MERGED' ? null : (pr.url ?? null);
}

/** The pull request this branch already has, or null when it has none to reuse. */
async function prFor(wt: Worktree): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', wt.branch, '--json', 'url,state'], {
      cwd: wt.path,
    });
    return reusablePr(stdout);
  } catch {
    // `gh` fails when there is no pull request to view, which is the ordinary case.
    return null;
  }
}

/**
 * How the pull request is merged: everything the ticket did, squashed into one
 * commit on the base. One ticket, one commit — the branch's own history is the
 * stages arguing with each other, which is in the workbench and is not what the
 * base wants. Its own function so the `--squash` can be tested without a network.
 */
export function mergeArgs(prUrl: string): string[] {
  return ['pr', 'merge', prUrl, '--squash'];
}

/** Refusals that are a decision: asking again gets the same answer. */
const SETTLED_REFUSALS = [
  'base branch policy',
  'required status',
  'review is required',
  'changes requested',
  'permission',
];

/** Refusals that mean GitHub has not caught up with the base that just moved. */
const NOT_CAUGHT_UP = [
  'not mergeable',
  'cannot be cleanly created',
  'base branch was modified',
  'try the merge again',
];

/**
 * Whether a `gh pr merge` refusal is worth asking again about.
 *
 * Merging moves the base under every other pull request, and GitHub works out
 * whether those can still be merged on its own schedule. Asked in between it says
 * no — in the same words it uses for one that genuinely cannot be merged, which is
 * why this is two lists and not a flag, and why the settled refusals are checked
 * first: GitHub words several of them as "not mergeable" too.
 *
 * A real conflict never reaches here — `doMergePr` brings the base into the branch
 * first and blocks on a clash — so retrying the ambiguous ones is bounded, and the
 * ticket still blocks after the last attempt. Its own function, like `mergeArgs`,
 * so the decision can be tested without a network.
 */
export function retryableMergeFailure(message: string): boolean {
  const said = message.toLowerCase();
  if (SETTLED_REFUSALS.some((phrase) => said.includes(phrase))) return false;
  return NOT_CAUGHT_UP.some((phrase) => said.includes(phrase));
}

/**
 * Whether the pull request has already merged, out of what `gh pr view` says about
 * it. Sibling of `reusablePr`, and the same input.
 *
 * `gh pr merge` on a merged pull request is an error, and the workbench can arrive
 * at one honestly: the merge may have landed and the answer been lost — to a retry,
 * or to `wb serve` being restarted with the request still standing.
 */
export function alreadyMerged(stdout: string): boolean {
  return (JSON.parse(stdout) as { state?: string }).state === 'MERGED';
}

/** How many times `gh pr merge` is asked, and how long is left between the asks. */
const MERGE_ATTEMPTS = 4;
const mergeBackoffMs = (attempt: number) => 3_000 * 2 ** (attempt - 1);

/**
 * Pushes the branch and merges the pull request.
 *
 * The push first because the branch may have gained a commit the pull request has
 * never seen: bringing the base in happens here, immediately before this, and
 * merging without it would merge the code as GitHub last saw it.
 *
 * Asked more than once, because `gh pr merge` asks whether the branch can be merged
 * once and never again: a base that moved a moment ago is answered no, the ticket
 * blocks, and it looks exactly like a real conflict. The state is read before the
 * first ask and after every refusal, so a merge that has already landed is finished
 * rather than asked for a second time.
 */
export async function mergePr(wt: Worktree, prUrl: string): Promise<void> {
  if (await merged(prUrl, wt.path)) return;

  await run('git', ['push', 'origin', wt.branch], { cwd: wt.path });

  for (let attempt = 1; ; attempt++) {
    try {
      await run('gh', mergeArgs(prUrl), { cwd: wt.path });
      return;
    } catch (error) {
      if (await merged(prUrl, wt.path)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MERGE_ATTEMPTS || !retryableMergeFailure(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, mergeBackoffMs(attempt)));
    }
  }
}

/**
 * Whether the pull request has merged, as the host has it. Never throws: being
 * unable to read is a blip, and what settles whether it merged is the merge.
 */
async function merged(prUrl: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', prUrl, '--json', 'state'], { cwd });
    return alreadyMerged(stdout);
  } catch {
    return false;
  }
}

export async function verdict(prUrl: string, cwd: string): Promise<Verdict> {
  const { stdout } = await run('gh', ['pr', 'view', prUrl, '--json', 'state,reviews,commits'], {
    cwd,
  });
  return readVerdict(JSON.parse(stdout) as PrState);
}
