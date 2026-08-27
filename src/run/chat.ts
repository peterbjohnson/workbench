import {
  query,
  type HookCallback,
  type Options,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { Event, Proposal } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { chatTurns, runs, statusOf } from '../domain/board.ts';
import type { ChatAgentDef } from '../agents/load.ts';
import { wbServer } from '../tools/server.ts';
import { guard, type GuardContext } from './guard.ts';
import { createLiveChats } from './liveChat.ts';
import { readProposals } from './protocol.ts';

/**
 * One turn of the manager's conversation with a ticket, and what came back. The API
 * holds one of these and knows nothing else about how a chat happens — the same way
 * the orchestrator holds a `StageRunner`.
 */
export type ChatRunner = (ask: ChatAsk) => Promise<ChatReply>;

/**
 * The chat, and the subprocess it keeps alive between the turns of one conversation.
 * The API is handed `chat` alone and knows nothing about the rest; the composition
 * root wires `warm` to the pane opening and `close` to the workbench stopping.
 */
export type Chats = {
  chat: ChatRunner;
  /** A ticket's pane is open, so a turn is coming. Have something up for it. */
  warm: (ticket: Ticket) => void;
  close: () => Promise<void>;
};

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

/**
 * How one attempt at a turn ended. `failed` is why it has no answer, and is here so
 * that a resume which never reached the model can be told from a run that reached it
 * and went wrong: only the first is worth starting again from the top.
 */
type Attempt = { text: string; costUsd: number; sessionId?: string; failed?: string };

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
 * The chat agent, as a runner. It reads and it talks: the tool grant says what it may
 * do at all, and the same guard every stage runs under says where — a read is confined
 * to where the chat is reading like any other tool call, which for a ticket that has
 * not started is the repository itself.
 *
 * What it costs is reported and recorded on the turn, and never added to the ticket's
 * own spend: talking about a ticket must not be able to push it past `maxTicketUsd`
 * and stop the work being talked about.
 */
export function createChatRunner(deps: ChatRunnerDeps): Chats {
  const live = createLiveChats(deps.query === undefined ? {} : { run: deps.query });

  return { chat, warm, close: live.close };

  /**
   * The pane on a ticket has been opened, so a turn is coming. Starting the process
   * now rather than when Send is pressed is the whole of what this saves on the first
   * turn — the one the manager actually sits and waits through.
   */
  function warm(ticket: Ticket): void {
    const agent = deps.agent();
    const cwd = deps.cwd(ticket);
    live.warm(
      keyFor(deps, agent, ticket, cwd),
      chatOptions(deps, agent, cwd, new AbortController()),
    );
  }

  async function chat({
    ticket,
    events,
    message,
    resumeFrom,
    signal,
  }: ChatAsk): Promise<ChatReply> {
    const agent = deps.agent();
    const cwd = deps.cwd(ticket);

    // The process the pane started when it was opened, if it is still there and is
    // still this ticket's. It has not been anywhere, so there is no session to load
    // back off disk — and loading one is most of what a turn used to cost.
    //
    // One that has answered before holds the brief already and is told the message
    // alone; one only just started is told the whole ticket, as a cold turn is —
    // including the conversation so far, because it wins over `resumeFrom` and would
    // otherwise answer having seen none of what the pane is showing.
    const alive = await live.take(
      keyFor(deps, agent, ticket, cwd),
      (fresh) => (fresh ? brief(deps, agent, ticket, events, message) : message),
      signal,
    );
    // The same rule the resume below follows, for the same reason: an attempt that
    // spent money reached the model, so its ending is this turn's answer however bad
    // it is, and starting again would pay twice for the one turn.
    //
    // A cap is the exception. `maxTurns` and `maxBudgetUsd` bound a query, and a
    // living process's query is the whole conversation, so a few questions in they
    // end a turn on an allowance written for one — and the pane would show an error
    // where a cold turn, whose caps are its own again, answers. What is not repeated
    // there is the question, not the charge: the cut-off attempt reached the model
    // and that money is gone, so it is carried onto whatever does answer and the turn
    // is reported at what it actually took.
    let alreadySpent = 0;
    if (alive !== undefined) {
      if (alive.capped === true) alreadySpent = alive.costUsd;
      else if (alive.failed === undefined || alive.costUsd > 0) return replyTo(alive);
    }

    // Nothing was standing, or what was standing could not serve this turn: it had
    // died, or timed out, or the agent file was edited under it. Start one now,
    // because opening the pane is the only other thing that ever does — so without
    // this one gap in a conversation, or one process that died, is spawn-and-resume
    // from there on for good.
    //
    // Before the cold turn rather than after it: the boot is paid in the time that
    // turn spends thinking, and a turn that ends badly still leaves something up for
    // the next one.
    warm(ticket);

    // Resuming is worth a try but must never be worth a chat that cannot be had
    // again. The session lives in ~/.claude/projects on one machine and can simply
    // be gone — and it goes for certain the first time a ticket is queued, because
    // the cwd moves from the repository to the ticket's own worktree, and the
    // session is looked for under the path it was started from.
    //
    // A resumed conversation already holds the ticket and everything the agent read
    // to answer the last turn, so it is told the message alone: rebuilding the brief
    // would be paying twice for it.
    if (resumeFrom !== undefined) {
      const resumed = await runOnce(message, resumeFrom);
      // Only start again if the attempt got nowhere. One that spent money reached
      // the model, so the session was there and this is its answer however bad;
      // running it again would pay twice for the same turn.
      if (resumed.failed === undefined || resumed.costUsd > 0) return replyTo(resumed);
    }

    // Either a first turn or a conversation the agent has lost, which comes to the
    // same thing: it is told the whole ticket, and the reply carries the new session
    // for the next turn to resume — so the chat is never stuck on a dead one.
    return replyTo(await runOnce(brief(deps, agent, ticket, events, message)));

    async function runOnce(prompt: string, resume?: string): Promise<Attempt> {
      const abortController = new AbortController();
      const relayAbort = () => abortController.abort();
      signal.addEventListener('abort', relayAbort, { once: true });
      if (signal.aborted) relayAbort();

      const options: Options = {
        ...chatOptions(deps, agent, cwd, abortController),
        // The one thing that is not the same for every chat process: which
        // conversation it is picking up. A living one is already in its own.
        ...(resume !== undefined ? { resume } : {}),
      };

      let text = '';
      let costUsd = 0;
      let sessionId: string | undefined;
      let failed: string | undefined;

      try {
        for await (const said of (deps.query ?? query)({ prompt, options })) {
          sessionId ??= said.session_id;
          if (said.type === 'result') {
            costUsd += said.total_cost_usd;
            if (said.subtype === 'success') text = said.result;
            else failed = `the chat stopped: ${said.subtype}`;
          }
        }
      } catch (error) {
        // Caught rather than left to escape: a resume that could not find its session
        // throws, and that is the one failure this runner can do something about.
        failed = error instanceof Error ? error.message : String(error);
      }

      return { text, costUsd, sessionId, failed };
    }

    function replyTo(attempt: Attempt): ChatReply {
      // Thrown rather than reported as an empty turn: unlike a stage, a chat has
      // nobody downstream to make sense of silence, and the manager is sitting in
      // front of it. The route turns this into the reason the pane shows.
      if (attempt.failed !== undefined) throw new Error(attempt.failed);

      return {
        text: attempt.text,
        proposals: readProposals(attempt.text),
        costUsd: attempt.costUsd + alreadySpent,
        ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
      };
    }
  }
}

/**
 * Everything a chat process is started with, apart from which conversation it is
 * picking up. One function so that a process kept alive between turns and one
 * spawned for a single turn are provably started the same way: what the chat may
 * reach is settled at spawn and cannot be changed after, so keeping a process alive
 * must not be able to widen it.
 */
function chatOptions(
  deps: ChatRunnerDeps,
  agent: ChatAgentDef,
  cwd: string,
  abortController: AbortController,
): Options {
  return {
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
    hooks: {
      PreToolUse: [
        {
          hooks: [
            toolHook({
              worktree: cwd,
              allowedTools: agent.allowedTools,
              protectedPaths: deps.protectedPaths,
            }),
          ],
        },
      ],
    },
    canUseTool: async (toolName): Promise<PermissionResult> => ({
      behavior: 'deny',
      message: `${toolName} is not available to the chat`,
    }),
  };
}

/**
 * What a living process was started to serve, as one string. Everything in it is
 * settled at spawn and cannot be changed after: the ticket it is reading about,
 * where it is reading, and the whole agent definition — instructions included, so
 * that editing `chat.md` retires the process rather than being served stale by it.
 */
function keyFor(deps: ChatRunnerDeps, agent: ChatAgentDef, ticket: Ticket, cwd: string): string {
  return JSON.stringify([ticket.id, cwd, agent, deps.protectedPaths]);
}

/**
 * Where the chat may read, decided before every tool call. A hook rather than
 * `canUseTool` for the reason the stages use one: a tool named in `allowedTools` is
 * auto-approved before that callback is ever consulted, so `Read` would otherwise
 * reach anywhere on the machine — and whatever it read would come back in a reply
 * the workbench stores on the ticket.
 *
 * Nothing is recorded, unlike a stage's: a chat has no run to record against, and
 * the manager is sitting in front of the refusal as it happens.
 */
function toolHook(ctx: GuardContext): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const verdict = guard(ctx, input.tool_name, input.tool_input);
    if (verdict.allow) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: verdict.reason,
      },
    };
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
    ['Completion criteria', ticket.completionCriteria.map((c) => `- ${c}`).join('\n') || undefined],
    ['What the stages said', whatTheStagesSaid(events)],
    ['The conversation so far', conversationSoFar(events, message)],
    ['What the manager just said', message],
  ];

  const body = sections
    .filter((s): s is [string, string] => s[1] !== undefined && s[1] !== '')
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join('\n\n');

  return `${agent.instructions}\n\n---\n\n${body}\n`;
}

/**
 * The conversation the pane is showing, which a session picked back up would have
 * held already. A brief is what a process that has been nowhere is told, and a warmed
 * one has been nowhere — so without this the first turn after a pane is reopened
 * answers having seen none of what is on the screen above it, which is a worse turn
 * than the slow one it replaced.
 *
 * The manager's turn is appended before the runner is called, so the last of these is
 * the message that is already a section of its own.
 */
function conversationSoFar(events: readonly Event[], message: string): string {
  const turns = chatTurns(events).turns;
  const last = turns.at(-1);
  const earlier = last?.role === 'manager' && last.text === message ? turns.slice(0, -1) : turns;

  return earlier
    .map((turn) => `**${turn.role === 'manager' ? 'The manager' : 'You'}:** ${turn.text}`)
    .join('\n\n');
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
