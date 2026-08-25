import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Refreshed } from '../domain/events.ts';
import type { Workspace } from '../orchestrator/loop.ts';

const run = promisify(execFile);

/**
 * Git as the orchestrator's workspace: a branch and a worktree per ticket. The
 * only place that knows the loop's `Workspace` is answered with git, which is
 * what makes the loop itself free of it.
 */
export function gitWorkspace(cfg: GitConfig): Workspace {
  return {
    prepare: (ticketId, from) => create(cfg, ticketId, from),
    refresh: (ticketId) => refresh(cfg, ticketId),
    commit: (ticket, message) => commitAll(worktreeFor(cfg, ticket.id), message),
    discard: (ticketId) => remove(cfg, ticketId),
  };
}

export type GitConfig = {
  /** The repository the work happens in. */
  repoRoot: string;
  /** Where worktrees are put. One directory per ticket. */
  worktreeRoot: string;
  /** The branch new work starts from. */
  base: string;
  /**
   * Directories left out of every ticket worktree — the workbench's own source.
   * They stay in the branch and in commits; they are simply not on disk for an
   * agent to reach. Defence by absence rather than by rule.
   */
  protectedPaths?: readonly string[];
};

export type Worktree = {
  ticketId: string;
  branch: string;
  path: string;
  /**
   * Somewhere to put working-out: a probe test, a scratch clone, a file written
   * only to see what happens. Beside the worktree rather than inside it, because
   * only the worktree is committed — so nothing left here can reach a pull
   * request, however forgetful the agent that made it.
   */
  scratch: string;
};

/** A worktree, plus what it was cut from the first time it was made. */
export type Branched = Worktree & { base: string | null };

export function worktreeFor(cfg: GitConfig, ticketId: string): Worktree {
  return {
    ticketId,
    branch: `wb/${ticketId}`,
    path: path.join(cfg.worktreeRoot, ticketId),
    scratch: path.join(cfg.worktreeRoot, `${ticketId}.scratch`),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * One worktree and one branch per ticket, so concurrent tickets cannot collide
 * and the manager's own working tree is never touched.
 *
 * Idempotent: calling it for a ticket that already has a worktree returns the
 * existing one, so a restart mid-ticket picks up where it left off.
 */
export async function create(
  cfg: GitConfig,
  ticketId: string,
  /**
   * The branch to cut this ticket from, when it carries on from another one.
   * Absent means the base as the remote has it, which is where work normally
   * starts. This is what puts an earlier ticket's commits inside the new
   * worktree, where they can be read and edited without any exception to the
   * guard: the whole reason work that stopped is otherwise unreachable.
   */
  from?: string,
): Promise<Branched> {
  const wt = worktreeFor(cfg, ticketId);
  // Every call, not only the first: a stage that runs after a restart finds the
  // worktree already there and would otherwise have nowhere to work.
  await fs.mkdir(wt.scratch, { recursive: true });
  if (await exists(wt.path)) return { ...wt, base: null };

  await fs.mkdir(cfg.worktreeRoot, { recursive: true });

  const branchExists = await git(cfg.repoRoot, 'branch', '--list', wt.branch).then(
    (out) => out.trim() !== '',
  );

  let base: string | null = null;
  if (branchExists) {
    await git(cfg.repoRoot, 'worktree', 'add', wt.path, wt.branch);
  } else {
    const startFrom = from ?? (await startPoint(cfg));
    base = (await git(cfg.repoRoot, 'rev-parse', startFrom)).trim();
    await git(cfg.repoRoot, 'worktree', 'add', '-b', wt.branch, wt.path, startFrom);
  }

  await hideProtectedPaths(cfg, wt);
  return { ...wt, base };
}

/**
 * Where a new ticket branches from: the base as the remote has it, fetched first.
 *
 * Local `main` goes stale the moment a pull request is merged on the code host,
 * and a ticket branched from it works against code that no longer exists — the
 * first live one asked why the files it was told to delete were not there, and it
 * was right to. Fetching and branching from `origin/<base>` fixes that without
 * touching the manager's own `main`: no pull, no merge, nothing to conflict.
 *
 * Falls back to the local base when there is no remote, so a repository without
 * one still works.
 */
async function startPoint(cfg: GitConfig): Promise<string> {
  try {
    await git(cfg.repoRoot, 'fetch', '--quiet', 'origin', cfg.base);
    const remote = `origin/${cfg.base}`;
    await git(cfg.repoRoot, 'rev-parse', '--verify', '--quiet', `${remote}^{commit}`);
    return remote;
  } catch {
    return cfg.base;
  }
}

/**
 * Excludes the protected directories from this worktree using sparse checkout.
 * The files remain in the index and in anything committed from here — they are
 * only absent from disk, which is what puts them beyond every tool at once.
 */
async function hideProtectedPaths(cfg: GitConfig, wt: Worktree): Promise<void> {
  const paths = cfg.protectedPaths ?? [];
  if (paths.length === 0) return;

  await git(wt.path, 'sparse-checkout', 'init', '--no-cone');
  // No trailing slash: in gitignore syntax `foo/` is a directory and `foo` is either,
  // and a protected path is not always one — the repository root's `package.json`
  // names the workbench that governs the next ticket, so an agent must not write it.
  const patterns = ['/*', ...paths.map((p) => `!/${p.replace(/^\/+|\/+$/g, '')}`)];
  await git(wt.path, 'sparse-checkout', 'set', ...patterns);
}

/**
 * Removes the worktree directory and the scratch beside it. The branch is left
 * alone — it may be in a pull request.
 */
export async function remove(cfg: GitConfig, ticketId: string): Promise<void> {
  const wt = worktreeFor(cfg, ticketId);
  await fs.rm(wt.scratch, { recursive: true, force: true });
  if (!(await exists(wt.path))) return;
  await git(cfg.repoRoot, 'worktree', 'remove', wt.path, '--force');
}

/**
 * Returns the commit it made, or null when there was nothing to commit — which is
 * normal for the stages that only read. The sha is the ticket's record of what it
 * actually did, so it is returned rather than thrown away.
 */
export async function commitAll(wt: Worktree, message: string): Promise<string | null> {
  await git(wt.path, 'add', '-A');
  const staged = await git(wt.path, 'diff', '--cached', '--name-only');
  if (staged.trim() === '') return null;
  await git(wt.path, 'commit', '-m', message);
  return (await git(wt.path, 'rev-parse', 'HEAD')).trim();
}

/**
 * The change this ticket has made, against what it actually started from.
 *
 * `from` is the commit recorded when the branch was cut. Using it rather than
 * `cfg.base` matters twice over: a ticket carrying on from another started on
 * that one's branch, and diffing against `main` would present all of the earlier
 * ticket's work as this one's change — several thousand words for a reviewer to
 * read as though they were new. And for an ordinary ticket `cfg.base` is the
 * *local* branch, which is the staleness `startPoint` exists to avoid.
 *
 * Falls back to the configured base for tickets branched before this was recorded.
 */
export async function diff(cfg: GitConfig, wt: Worktree, from?: string | null): Promise<string> {
  return git(wt.path, 'diff', `${from ?? cfg.base}...HEAD`);
}

/**
 * Brings the base as the remote now has it into the ticket's branch.
 *
 * A branch is cut from the base once and then works for hours while other tickets
 * merge, so by the time it is offered it is built on a base that no longer exists.
 * That is where conflicts come from, and the answer is not to resolve them better
 * but to not go stale: pull the base in, and let the ticket's own checks say
 * whether it still works against it.
 *
 * A merge rather than a rebase. Rebasing means force-pushing a branch that may
 * already have a pull request on it, which rewrites every commit a standing review
 * was written against.
 */
export async function refresh(cfg: GitConfig, ticketId: string): Promise<Refreshed> {
  const wt = worktreeFor(cfg, ticketId);
  const base = (await git(wt.path, 'rev-parse', await startPoint(cfg))).trim();

  const has = await git(wt.path, 'merge-base', '--is-ancestor', base, 'HEAD').then(
    () => true,
    () => false,
  );
  if (has) return { kind: 'up-to-date' };

  try {
    await git(wt.path, 'merge', '--no-edit', base);
  } catch {
    // Read the conflicting paths before aborting: the abort is what removes them.
    const paths = await git(wt.path, 'diff', '--name-only', '--diff-filter=U').then(
      (out) => out.split('\n').filter((line) => line !== ''),
      () => [],
    );
    await git(wt.path, 'merge', '--abort').catch(() => {});
    await hideProtectedPaths(cfg, wt);
    return { kind: 'conflicted', base, paths };
  }

  // A merge writes out whatever it had to merge, which can put a protected path
  // back on disk that the sparse checkout was keeping off it. Re-applied here so
  // the workbench's own source cannot appear in a worktree by way of a merge.
  await hideProtectedPaths(cfg, wt);
  return { kind: 'merged', base, commit: (await git(wt.path, 'rev-parse', 'HEAD')).trim() };
}
