import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { guard } from '../run/guard.ts';
import { indexTree, type FileFacts } from '../code/symbols.ts';
import { outline, references } from '../code/report.ts';
import { qualified, SERVER, type ToolName } from './names.ts';

/**
 * The workbench's own tools: what an experienced reader of this repository would do
 * before opening anything, done deterministically and in one call.
 *
 * Only two, and both read-only. `Read` and `Grep` stay because the model reaches for
 * them by reflex and a tool with a built-in rival gets the schema cost of both and the
 * usage of one. These two have no rival: nothing built in answers "what is defined
 * here" or "how is this name used", and a `Grep` line match is not the second answer —
 * it is a pointer to a file the agent then reads, which is where the re-reads come from.
 */

export type ToolContext = {
  worktree: string;
  scratch?: string;
  protectedPaths: readonly string[];
};

/** Enough to answer with, small enough that answering is cheaper than the question. */
const MAX_CHARS = 8_000;

/**
 * The tools this stage was granted, as an MCP server, or nothing if it was granted none.
 *
 * Built per run, from that stage's own list. `allowedTools` does not restrict — it only
 * auto-approves — so a server registered once for everyone would put `where` in front of
 * a stage that cannot call it, and the stage would call it and lose a turn to a refusal.
 * Per-run also keeps one ticket's worktree out of another's: tickets run concurrently in
 * slots, and a shared server would close over whichever worktree happened to be first.
 */
export function wbServer(
  ctx: ToolContext,
  granted: readonly string[],
): Record<string, McpServerConfig> {
  const tools = definitions(ctx).filter((t) => granted.includes(qualified(t.name)));
  if (tools.length === 0) return {};

  return {
    [SERVER]: createSdkMcpServer({
      name: SERVER,
      version: '1.0.0',
      // Or the tools sit behind ToolSearch and every stage spends a turn discovering
      // them, which is the saving spent before it is made.
      alwaysLoad: true,
      tools,
    }),
  };
}

function definitions(ctx: ToolContext) {
  return [
    tool(
      'map',
      [
        'Everything defined in a file or directory: functions, classes, constants, and',
        'for Markdown the headings, tables and figures — each with the lines it spans.',
        'Use it to find what to read before reading it. Your brief already lists every',
        'file, so this is for looking inside one.',
      ].join(' '),
      {
        path: z
          .string()
          .describe('A file or directory, relative to the worktree root. "." for all of it.'),
      },
      guarded(ctx, 'map', async (args: { path: string }) => {
        const facts = await under(ctx, args.path);
        if (facts.length === 0) return `Nothing at ${args.path}.`;
        return outline(facts);
      }),
    ),

    tool(
      'where',
      [
        'Every use of a name, grouped by what the use is: where it is defined, imported,',
        'called (with how many arguments), read as an attribute, or assigned. Answers',
        '"how is this used" in one call, which a Grep line match does not.',
        'Matches on the name alone — Python and JavaScript are parsed, not resolved, so',
        'two different functions with the same name are both reported.',
        'Prose is not searched: for words in Markdown, use Grep.',
      ].join(' '),
      {
        name: z.string().describe('The exact identifier. Not a pattern, not a regex.'),
        path: z
          .string()
          .optional()
          .describe('Narrow to a file or directory. Omit to search the whole worktree.'),
      },
      guarded(ctx, 'where', async (args: { name: string; path?: string }) => {
        const facts = await under(ctx, args.path ?? '.');
        return references(facts, args.name);
      }),
    ),
  ];
}

/** The indexed files at or under a path, which may name one file or a directory. */
async function under(ctx: ToolContext, where: string): Promise<FileFacts[]> {
  const facts = await indexTree(ctx.worktree);
  const wanted = normalise(where);
  if (wanted === '') return facts;

  return facts.filter((f) => f.path === wanted || f.path.startsWith(`${wanted}/`));
}

/** A worktree-relative path, however the agent chose to write it. */
function normalise(where: string): string {
  const trimmed = where
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

/**
 * One tool handler, answerable to the same guard the hook asks.
 *
 * It re-asks rather than trusting the hook for two reasons. The hook is a `PreToolUse`
 * callback and nothing in this repository has yet proved it fires for MCP calls, so
 * relying on it alone would be relying on something unverified for confinement. And
 * these handlers run in the workbench's own process, where `process.cwd()` is the
 * workbench and not the worktree — so a relative path in a tool argument resolves
 * somewhere entirely different from the same string in a `Bash` call, and every path
 * has to be taken back to the worktree deliberately.
 *
 * Nothing throws out of here. An unhandled rejection in a tool handler is not a failed
 * tool call, it is `wb serve` going down and taking every concurrent ticket with it.
 */
function guarded<A extends object>(
  ctx: ToolContext,
  name: ToolName,
  run: (args: A) => Promise<string>,
) {
  return async (args: A) => {
    const verdict = guard({ ...ctx, allowedTools: [qualified(name)] }, qualified(name), args);
    if (!verdict.allow) return said(verdict.reason, true);

    try {
      const answer = await run(args);
      return said(clip(answer));
    } catch (error) {
      return said(error instanceof Error ? error.message : String(error), true);
    }
  };
}

function said(text: string, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text }] };
}

/**
 * The whole point of these tools is that an answer costs less than the question. One
 * that ran to a hundred kilobytes would be the very thing they exist to stop.
 */
function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n… cut here. Narrow it with a path.`;
}

/**
 * The tools, for tests and for anything that wants to call one without an SDK session.
 * A definition carries its own `handler`, so a test drives the real thing rather than
 * a copy of it that can drift.
 */
export function wbTools(ctx: ToolContext) {
  return definitions(ctx);
}
