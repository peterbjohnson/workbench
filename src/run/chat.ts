import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import type { Event, Proposal } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { runs, statusOf } from '../domain/board.ts';
import type { ChatAgentDef } from '../agents/load.ts';
import { wbServer } from '../tools/server.ts';
import { readProposals } from './protocol.ts';

/**
 * One turn of the manager's conversation with a ticket, and what came back. The API
 * holds one of these and knows nothing else about how a chat happens — the same way
 * the orchestrator holds a `StageRunner`.
 */
export type ChatRunner = (ask: ChatAsk) => Promise<ChatReply>;

export type ChatAsk = {
  ticket: Ticket;
  /** The ticket's whole history, which is what the agent is briefed from. */
  events: readonly Event[];
  /** What the manager just said. */
  message: string;
  /** The conversation to carry on, when the agent has one. */
  resumeFrom?: string;
  signal: AbortSignal;
};

export type ChatReply = {
  text: string;
  proposals: Proposal[];
  costUsd: number;
  sessionId?: string;
};

export type ChatRunnerDeps = {
  /** Asked for per turn, not held: the board edits this file like the other four. */
  agent: () => ChatAgentDef;
  /**
   * Where the chat may read. The ticket's own worktree once it has one, so a
   * conversation about work in progress is about that work — and the repository
   * itself before then, when there is nothing else to look at.
   */
  cwd: (ticket: Ticket) => string;
  protectedPaths: readonly string[];
  /** What the project is, the same text every stage is given. */
  about: string;
  /** The SDK's own unless a test hands over one that answers without a network. */
  query?: typeof query;
};

/**
 * The chat agent, as a runner. It reads and it talks; it has no tool that writes and
 * no guard hook, because there is nothing for a guard to stop — the wall is the tool
 * grant, and anything the grant did not name is denied outright.
 *
 * What it costs is reported and recorded on the turn, and never added to the ticket's
 * own spend: talking about a ticket must not be able to push it past `maxTicketUsd`
 * and stop the work being talked about.
 */
export function createChatRunner(deps: ChatRunnerDeps): ChatRunner {
  return async function chat({ ticket, events, message, resumeFrom, signal }): Promise<ChatReply> {
    const agent = deps.agent();
    const cwd = deps.cwd(ticket);

    const abortController = new AbortController();
    const relayAbort = () => abortController.abort();
    signal.addEventListener('abort', relayAbort, { once: true });
    if (signal.aborted) relayAbort();

    const options: Options = {
      ...(resumeFrom !== undefined ? { resume: resumeFrom } : {}),
      cwd,
      model: agent.model,
      effort: agent.effort,
      permissionMode: agent.permissionMode,
      allowedTools: [...agent.allowedTools],
      disallowedTools: [...agent.disallowedTools],
      maxTurns: agent.maxTurns,
      maxBudgetUsd: agent.maxBudgetUsd,
      abortController,
      // Nothing from this machine, and no skills: this agent is a reader and a
      // talker, and expertise about how work is done here is for the stages doing it.
      settingSources: [],
      mcpServers: wbServer(
        { worktree: cwd, protectedPaths: deps.protectedPaths },
        agent.allowedTools,
      ),
      strictMcpConfig: true,
      env: { ...process.env, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
      canUseTool: async (toolName): Promise<PermissionResult> => ({
        behavior: 'deny',
        message: `${toolName} is not available to the chat`,
      }),
    };

    // A resumed conversation already holds the ticket and everything the agent read
    // to answer the last turn. Rebuilding the brief would be paying twice for it.
    const prompt = resumeFrom === undefined ? brief(deps, agent, ticket, events, message) : message;

    let text = '';
    let stopped: string | undefined;
    let costUsd = 0;
    let sessionId: string | undefined;

    for await (const said of (deps.query ?? query)({ prompt, options })) {
      sessionId ??= said.session_id;
      if (said.type === 'result') {
        costUsd += said.total_cost_usd;
        if (said.subtype === 'success') text = said.result;
        else stopped = said.subtype;
      }
    }

    // Thrown rather than reported as an empty turn: unlike a stage, a chat has nobody
    // downstream to make sense of silence, and the manager is sitting in front of it.
    if (stopped !== undefined) throw new Error(`the chat stopped: ${stopped}`);

    return { text, proposals: readProposals(text), costUsd, ...(sessionId ? { sessionId } : {}) };
  };
}

/**
 * What the chat agent is told before the first thing the manager says. Short on
 * purpose: it can read the repository, and everything here is what it could not find
 * out by reading — the ticket, where it has got to, and what the stages made of it.
 */
function brief(
  deps: ChatRunnerDeps,
  agent: ChatAgentDef,
  ticket: Ticket,
  events: readonly Event[],
  message: string,
): string {
  const sections: [string, string | undefined][] = [
    ['About this project', deps.about.trim() || undefined],
    ['Where you are reading', `\`${deps.cwd(ticket)}\``],
    ['Ticket', `**${ticket.id} — ${ticket.title}**\n\n${ticket.body}`.trim()],
    ['Where it has got to', whereItIs(ticket)],
    ['The plan', ticket.plan ?? undefined],
    ['Done when', ticket.doneWhen.map((d) => `- ${d}`).join('\n') || undefined],
    ['What the stages said', whatTheStagesSaid(events)],
    ['What the manager just said', message],
  ];

  const body = sections
    .filter((s): s is [string, string] => s[1] !== undefined && s[1] !== '')
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join('\n\n');

  return `${agent.instructions}\n\n---\n\n${body}\n`;
}

function whereItIs(ticket: Ticket): string {
  const notes = [
    `Status: ${ticket.status.replace(/_/g, ' ')}${ticket.running ? ' (a stage is running)' : ''}`,
    ticket.question !== null ? `Waiting on the manager: ${ticket.question.question}` : undefined,
    ticket.rejection !== null ? `Sent back because: ${ticket.rejection}` : undefined,
    ticket.changes !== null ? `Changes asked for: ${ticket.changes}` : undefined,
    ticket.commits.length > 0
      ? `${ticket.commits.length} commit(s) on ${ticket.branch}`
      : undefined,
  ];
  return notes.filter((n) => n !== undefined).join('\n');
}

/**
 * Each stage run in a line: what it was, how it went, and the first thing it said.
 * The whole of what a stage wrote is pages, and a conversation that needed all of it
 * would have to be paid for on every turn.
 */
function whatTheStagesSaid(events: readonly Event[]): string | undefined {
  const stages = runs(events);
  if (stages.length === 0) return undefined;

  return stages
    .map((run) => {
      const said = run.rejected ?? run.changes ?? run.summary;
      const first = said.trim().split('\n\n')[0]?.trim() ?? '';
      return `- **${run.stage}** — ${statusOf(run)}${first === '' ? '' : `: ${first}`}`;
    })
    .join('\n');
}
