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
    refresh: (ticketId, alsoMerge) => refresh(cfg, ticketId, alsoMerge),
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
 *
 * Not raw git output: what comes back has been cut down to a size the model it is
 * put in front of can afford to read. See `readable`.
 */
export async function diff(cfg: GitConfig, wt: Worktree, from?: string | null): Promise<string> {
  return readable(await git(wt.path, 'diff', `${from ?? cfg.base}...HEAD`));
}

/**
 * What one file's hunks may take up before the diff carries its stat line instead.
 *
 * Not a preference, so not a setting: it is a fact about what a model can afford
 * to read. 32 KB is thousands of tokens of ordinary source and several times that
 * of anything denser, which is already more of one file than a reviewer reads
 * closely. Changes people write by hand do not reach it; the things that do are
 * generated, and are the reason this exists.
 */
const FILE_BUDGET = 32 * 1024;

/**
 * And what the whole diff may take up, once every file is inside `FILE_BUDGET`.
 * Four files at the per-file cap, or a great many small ones — either way it is
 * about as much diff as a stage can read in one prompt and still have money left
 * to think with.
 */
const DIFF_BUDGET = 128 * 1024;

/**
 * The change, cut down to what the model reading it can afford.
 *
 * A ticket committed a generated 924 KB CSV — 15,862 rows of node coordinates.
 * The change itself was one function and two tests and was correctly graded
 * small, so review ran on a small ticket's budget and spent all of it on the
 * first request, 28 seconds in, after two cheap tool calls and before it had
 * read anything. The size of a change and the size of its diff are uncorrelated
 * and always will be, so no better judgement of scale prevents this. The only
 * place it can be fixed is where the diff is built.
 *
 * Two caps, because there are two ways to be too big. A file over `FILE_BUDGET`
 * keeps its header and loses its hunks, whatever else is in the diff — the same
 * file elides the same way in every ticket, rather than depending on what
 * happened to change alongside it. Then, if the whole is still over
 * `DIFF_BUDGET` — three hundred files of a mechanical rename, no single one of
 * them large — the largest go the same way, biggest first, because that buys the
 * most room for the fewest files lost. The floor is one stat line per file: a
 * diff of thousands of files will still exceed the cap, and is still the shortest
 * true account of itself.
 *
 * Nothing is hidden, only moved: every file is still named, with its mode, its
 * counts and its rename, and both stages that are given a diff can `Read` any of
 * it out of the worktree. Saying so in the note is the whole point — an elision
 * the reader does not know about is a diff it will quietly misread, which is a
 * worse failure than the cost this saves.
 *
 * Safe to do at all because nothing parses this string. It has one producer and
 * one consumer, which fences it into a brief; it is only ever read by a model.
 */
function readable(whole: string): string {
  const files = byFile(whole).map((full) => {
    const stat = statOnly(full);
    return { stat, shown: full.length > FILE_BUDGET ? stat : full };
  });
  if (files.length === 0) return whole;

  let total = files.reduce((n, file) => n + file.shown.length, 0);
  for (const file of [...files].sort((a, b) => b.shown.length - a.shown.length)) {
    if (total <= DIFF_BUDGET) break;
    // Already elided, or a file with no body to take out. Either way it cannot
    // give up anything more, and the next-largest is where the room has to come
    // from — so this is a `continue` and not a `break`.
    if (file.stat.length >= file.shown.length) continue;
    total -= file.shown.length - file.stat.length;
    file.shown = file.stat;
  }

  return files.map((file) => file.shown).join('');
}

/**
 * The diff, split into one string per file, each still exactly as git wrote it.
 *
 * `diff --git` at column zero is only ever a header: every line of a hunk carries
 * a prefix, so a file whose contents contain that text appears as `+diff --git`.
 * If there are no headers, or anything before the first one, this is not the
 * shape assumed here — return nothing and let the caller pass the diff through
 * untouched, because a wrong guess about the shape would drop real work.
 */
function byFile(whole: string): string[] {
  const starts = [...whole.matchAll(/^diff --git .*$/gm)].map((match) => match.index);
  if (starts.length === 0 || starts[0] !== 0) return [];
  return starts.map((start, i) => whole.slice(start, starts[i + 1]));
}

/**
 * One file with its hunks taken out: the header git wrote, then a line saying how
 * much was left out and a note to the model about to read it.
 *
 * The header is kept verbatim rather than rebuilt, so a rename, a mode change or
 * a new file still says what it says. The counts are taken from the hunks being
 * dropped rather than from a second `git diff --numstat`, which keeps this a pure
 * function of the text and cannot disagree with what it replaced.
 */
function statOnly(file: string): string {
  const lines = file.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  // No hunks at all: a mode change, or a binary file git already declined to
  // render. There is nothing to take out and it is already short.
  if (firstHunk === -1) return file;

  const hunks = lines.slice(firstHunk);
  const added = hunks.filter((line) => line.startsWith('+')).length;
  const removed = hunks.filter((line) => line.startsWith('-')).length;
  const kb = Math.round(file.length / 1024);

  return [
    ...lines.slice(0, firstHunk),
    `${pathOf(lines)} | ${added} added, ${removed} removed, ${kb} KB`,
    'The body of this file is not shown. This change is larger than a stage can',
    'afford to read in one go, so the largest files were reduced to the line',
    'above. None of it is lost: the file is there in the worktree, and Read will',
    'fetch as much of it as you decide you need to judge this change.',
    '',
  ].join('\n');
}

/**
 * Which file that was. Taken from the `+++` line git has already written, and
 * from `---` when the file was deleted and there is no `+++` path to take: those
 * two name it the same way the `diff --git` line does, with one prefix to strip
 * and no second name on the line to tell it apart from.
 */
function pathOf(lines: readonly string[]): string {
  const to = lines.find((line) => line.startsWith('+++ '))?.slice(4);
  const from = lines.find((line) => line.startsWith('--- '))?.slice(4);
  const named = to !== undefined && to !== '/dev/null' ? to : from;
  return named === undefined ? 'this file' : named.replace(/^[ab]\//, '');
}

/**
 * Brings the base as the remote now has it into the ticket's branch, and with it
 * any other branch the caller names.
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
 *
 * They are merged one at a time and one may fail, so this does not leave the branch
 * either fully merged or as it was: everything before the failure stands. What it
 * returns says which, so the caller can record where the branch has actually got to.
 */
export async function refresh(
  cfg: GitConfig,
  ticketId: string,
  /**
   * Branches to bring in as well as the base: the work this ticket waited for,
   * which has been offered and so is not in the base yet. The commit it needs —
   * the base with all of them on it — does not exist anywhere, so it is made here,
   * on the ticket's own branch.
   */
  alsoMerge: readonly string[] = [],
): Promise<Refreshed> {
  const wt = worktreeFor(cfg, ticketId);
  const base = (await git(wt.path, 'rev-parse', await startPoint(cfg))).trim();

  const wanted: string[] = [];
  for (const ref of [base, ...alsoMerge]) {
    // A dependency with no branch has no work to take: it was released by ending
    // rather than by offering, or it never got as far as cutting one.
    const resolves = await git(wt.path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).then(
      () => true,
      () => false,
    );
    const has =
      resolves &&
      (await git(wt.path, 'merge-base', '--is-ancestor', ref, 'HEAD').then(
        () => true,
        () => false,
      ));
    if (resolves && !has) wanted.push(ref);
  }
  if (wanted.length === 0) return { kind: 'up-to-date' };

  const merged: string[] = [];
  for (const ref of wanted) {
    try {
      await git(wt.path, 'merge', '--no-edit', ref);
    } catch {
      // Read the conflicting paths before aborting: the abort is what removes them.
      const paths = await git(wt.path, 'diff', '--name-only', '--diff-filter=U').then(
        (out) => out.split('\n').filter((line) => line !== ''),
        () => [],
      );
      await git(wt.path, 'merge', '--abort').catch(() => {});
      await hideProtectedPaths(cfg, wt);
      // The HEAD after the abort, which is the one the earlier merges left. Read
      // here rather than assumed: what the caller records against the branch has to
      // be a commit the branch is actually standing on.
      const commit = (await git(wt.path, 'rev-parse', 'HEAD')).trim();
      return { kind: 'conflicted', base, paths, with: ref, merged, commit };
    }
    merged.push(ref);
  }

  // A merge writes out whatever it had to merge, which can put a protected path
  // back on disk that the sparse checkout was keeping off it. Re-applied here so
  // the workbench's own source cannot appear in a worktree by way of a merge.
  await hideProtectedPaths(cfg, wt);
  return {
    kind: 'merged',
    base,
    commit: (await git(wt.path, 'rev-parse', 'HEAD')).trim(),
    merged,
  };
}
