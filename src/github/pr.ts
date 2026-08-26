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

/** The pull request this branch already has, or null when it has none. */
async function prFor(wt: Worktree): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', wt.branch, '--json', 'url'], {
      cwd: wt.path,
    });
    return (JSON.parse(stdout) as { url?: string }).url ?? null;
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

/**
 * Pushes the branch and merges the pull request.
 *
 * The push first because the branch may have gained a commit the pull request has
 * never seen: bringing the base in happens here, immediately before this, and
 * merging without it would merge the code as GitHub last saw it.
 */
export async function mergePr(wt: Worktree, prUrl: string): Promise<void> {
  await run('git', ['push', 'origin', wt.branch], { cwd: wt.path });
  await run('gh', mergeArgs(prUrl), { cwd: wt.path });
}

export async function verdict(prUrl: string, cwd: string): Promise<Verdict> {
  const { stdout } = await run('gh', ['pr', 'view', prUrl, '--json', 'state,reviews,commits'], {
    cwd,
  });
  return readVerdict(JSON.parse(stdout) as PrState);
}
