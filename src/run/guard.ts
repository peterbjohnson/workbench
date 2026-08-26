import path from 'node:path';

import { WB_WRITE_TOOLS } from '../tools/names.ts';

export type GuardResult = { allow: true } | { allow: false; reason: string };

export type GuardContext = {
  /** Absolute path to the ticket's worktree. The only place work is committed from. */
  worktree: string;
  /**
   * Absolute path to the ticket's scratch directory: writable, outside the worktree,
   * and never committed. An agent with nowhere to put a probe puts it in the
   * worktree, where it ships — which is what t4 came within one `rm` of doing.
   */
  scratch?: string;
  /** The tools this stage was granted. */
  allowedTools: readonly string[];
  /**
   * The workbench's own skills, by canonical name. `Skill` is deliberately absent
   * from every agent's `allowedTools` — a bare entry there auto-approves the tool
   * before anything can inspect which skill was asked for — so this list is what
   * grants it, and it grants exactly these. Anything else on the machine, bundled
   * or installed, is refused however it got into the session.
   */
  skills?: readonly string[];
  /**
   * Directories inside the worktree that may be read but never written — the
   * workbench's own source, so an agent cannot edit the guardrails it runs under.
   * Paths are relative to the worktree.
   */
  protectedPaths?: readonly string[];
};

/**
 * Tools that change a file. Reading a protected path is allowed; writing to it is not.
 *
 * The workbench's own tools say for themselves whether they write, in `names.ts`, so
 * this cannot fall out of step with what is actually registered.
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', ...WB_WRITE_TOOLS]);

/**
 * Runs as a PreToolUse hook, so it fires on every call — including ones the SDK
 * would auto-approve. Every call is recorded whether or not it is allowed; the
 * refused ones are the more interesting half of the record.
 *
 * The real isolation is the worktree, not this function. Inspecting shell
 * commands is best-effort by nature: it catches the obvious, not the devious.
 */
export function guard(ctx: GuardContext, tool: string, input: unknown): GuardResult {
  if (tool === 'Skill') return skillAsked(ctx, input);

  if (!ctx.allowedTools.includes(tool)) {
    return { allow: false, reason: `the ${tool} tool is not granted to this stage` };
  }

  for (const p of pathsUsedBy(input)) {
    if (!reachable(ctx, p)) return { allow: false, reason: outOfBounds(ctx, p) };

    if (WRITE_TOOLS.has(tool)) {
      const protectedDir = (ctx.protectedPaths ?? []).find((dir) =>
        isInside(path.resolve(ctx.worktree, dir), path.resolve(ctx.worktree, p)),
      );
      if (protectedDir !== undefined) {
        return {
          allow: false,
          reason: `${protectedDir} is the workbench's own source and is read-only to agents`,
        };
      }
    }
  }

  if (tool === 'Bash') {
    const command = stringField(input, 'command') ?? '';
    const banned = BANNED_COMMANDS.find((b) => b.pattern.test(command));
    if (banned) return { allow: false, reason: banned.reason };

    const sweeping = badRecursiveDelete(ctx, command);
    if (sweeping !== undefined) return { allow: false, reason: sweeping };
  }

  return { allow: true };
}

/**
 * Which skill was asked for, judged against the ones the workbench has. A refusal
 * says what those are: t16 spent a plan stage and then the manager's attention on
 * expertise that was one call away, and a dead end is what made that expensive.
 */
function skillAsked(ctx: GuardContext, input: unknown): GuardResult {
  const skills = ctx.skills ?? [];
  const asked = stringField(input, 'skill') ?? '';

  // Qualified or bare — `workbench:writing-python` and `writing-python` name the
  // same expertise, and no agent should lose a turn to the prefix.
  if (skills.some((skill) => skill === asked || skill.endsWith(`:${asked}`))) {
    return { allow: true };
  }

  return {
    allow: false,
    reason:
      skills.length === 0
        ? 'this workbench has no skills'
        : `there is no skill "${asked}" here. The skills are: ${skills.join(', ')}`,
  };
}

/**
 * A recursive delete is judged by what it names, not by the flag it carries. The
 * blanket ban on `-r` refused an agent clearing its own scratch directory, which
 * is ordinary work, and cost a turn every time.
 *
 * Still refused: a target outside the writable roots, a target that *is* one of
 * those roots, and any target that cannot be read — a variable, a substitution or
 * a glob. Unreadable is refused rather than allowed, because the entire point is
 * to know what is about to be deleted.
 *
 * Best-effort, like everything else here: it splits on whitespace, so a quoted
 * path containing a space is refused, and it only sees `rm` at the head of a
 * segment, so `xargs rm -rf` goes unread. It catches the obvious, not the devious.
 *
 * @returns the reason to refuse, or undefined to allow.
 */
function badRecursiveDelete(ctx: GuardContext, command: string): string | undefined {
  for (const segment of command.split(/[;|&\n]+/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    if (words[0] !== 'rm') continue;

    const args = words.slice(1);
    // -rf, -fr, -R, or -f -r: a recursive flag however it is written or split.
    if (!args.some((a) => /^-[a-zA-Z]*[rR]/.test(a))) continue;

    const targets = args.filter((a) => !a.startsWith('-')).map(unquote);
    if (targets.length === 0) {
      return 'a recursive delete naming nothing is refused; say what to remove';
    }

    for (const target of targets) {
      // `~` is not here: it is perfectly readable — it means the home directory,
      // which `locate` already knows is outside, and saying so is the truer answer.
      if (/[$`*?]/.test(target)) {
        return `${target} could expand to anything, so this delete cannot be judged; name the directory outright`;
      }
      if (!reachable(ctx, target)) return outOfBounds(ctx, target);
      if (isRoot(ctx, target)) {
        return `${target} is a directory the workbench owns; empty it if you must, but do not remove it`;
      }
    }
  }
  return undefined;
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, '');
}

const BANNED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\bgit\s+commit\b/,
    reason: 'the workbench commits your work for you; do not commit',
  },
  {
    pattern: /\bgit\s+push\b/,
    reason: 'the workbench pushes and opens the pull request; do not push',
  },
  {
    // The workbench owns the branch, the worktree and what is checked out in it.
    // sparse-checkout and config in particular could undo the protections above,
    // and `merge --abort` would throw away a merge the workbench handed this stage
    // to resolve — which is how a stage could pass its end guard by discarding the
    // very thing it was asked to do. `merge` needs the lookahead because `\b` matches
    // before the hyphen too, and would take `merge-base` and `merge-file` with it:
    // read-only plumbing an agent resolving a merge has every reason to ask.
    pattern: /\bgit\s+(worktree|sparse-checkout|config|checkout|switch|reset|rebase|merge(?!-))\b/,
    reason: "the workbench owns this ticket's branch and worktree; leave git state alone",
  },
  // A recursive delete is not banned outright — see badRecursiveDelete, which
  // judges where it points rather than which flags it carries.
  { pattern: /\bsudo\b/, reason: 'sudo is not available' },
];

/**
 * Keys whose string values name a file or a directory, wherever they appear.
 *
 * This was a table of tool name to field name, which meant a tool the table had never
 * heard of contributed no paths at all — `pathsUsedBy` returned `[]`, the confinement
 * loop ran zero times, and the call was allowed. Every tool added from now on would
 * have had to remember to register itself, and the one that forgot would have been
 * unconfined rather than refused.
 *
 * Reading the keys instead fails the safe way round: a new tool is confined because it
 * spells its arguments the way every other tool does, and a tool that invents a new
 * spelling gets *more* scrutiny only when someone adds the key here.
 */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'paths']);

/**
 * Every path named anywhere in a tool call, however deeply it is nested.
 *
 * Walks objects and arrays because the workbench's own tools take batches — a `paths`
 * array, or a list of `{ path }` objects — and confining the first item of a batch
 * while ignoring the rest would be worse than not checking at all.
 */
function pathsUsedBy(input: unknown): string[] {
  const found: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    for (const [key, value] of Object.entries(node)) {
      if (PATH_KEYS.has(key)) {
        if (typeof value === 'string' && value !== '') found.push(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (typeof item === 'string' && item !== '') found.push(item);
        }
      }
      walk(value);
    }
  };

  walk(input);
  return found;
}

function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where a path lands. Resolved against the worktree, because that is the working
 * directory an agent's relative paths are written against — including the ones
 * that climb out of it, like `../t1.scratch/probe.py`.
 */
function locate(ctx: GuardContext, target: string): string | undefined {
  if (target.startsWith('~')) return undefined; // home-relative: never ours
  return path.resolve(ctx.worktree, target);
}

/** The two places an agent may touch: its worktree, and its scratch directory. */
function roots(ctx: GuardContext): string[] {
  return ctx.scratch === undefined ? [ctx.worktree] : [ctx.worktree, ctx.scratch];
}

function reachable(ctx: GuardContext, target: string): boolean {
  const at = locate(ctx, target);
  return at !== undefined && roots(ctx).some((root) => isInside(root, at));
}

/** True when the path *is* one of those places, rather than something within it. */
function isRoot(ctx: GuardContext, target: string): boolean {
  const at = locate(ctx, target);
  return at !== undefined && roots(ctx).some((root) => path.resolve(root) === at);
}

function outOfBounds(ctx: GuardContext, target: string): string {
  const allowed =
    ctx.scratch === undefined
      ? `work only inside ${ctx.worktree}`
      : `work inside ${ctx.worktree}, or ${ctx.scratch} for anything you do not want committed`;
  return `${target} is outside this ticket's workspace; ${allowed}`;
}

/** True when `target` resolves to `root` itself or something beneath it. */
function isInside(root: string, target: string): boolean {
  if (target.startsWith('~')) return false; // home-relative: never the worktree
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  if (absoluteTarget === absoluteRoot) return true;
  return absoluteTarget.startsWith(absoluteRoot + path.sep);
}
