import {
  query,
  type HookCallback,
  type Options,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { EventBody, Scale, Stage } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { forScale, type AgentDef, type SkillDef } from '../agents/load.ts';
import { buildBrief } from '../agents/brief.ts';
import { readApproval, readDoneWhen, readLater, readScale, readSteps } from './protocol.ts';
import { indexTree } from '../code/symbols.ts';
import { fileMap } from '../code/report.ts';
import { wbServer } from '../tools/server.ts';
import type { RunResult, StageRunner } from '../orchestrator/loop.ts';
import { guard } from './guard.ts';

export type StageRunnerDeps = {
  /**
   * Asked for per run, not held. The board edits these files, and an agent
   * definition read once at startup would mean a change you can see on screen and
   * cannot see in the work — which looks exactly like an edit that did not save.
   */
  agents: () => Record<Stage, AgentDef>;
  /** Directories inside the worktree that agents may read but never write. */
  protectedPaths: readonly string[];
  /**
   * What the project is, read once at startup and put in front of every stage.
   * Empty when the configured file does not exist, and then simply not said.
   */
  about: string;
  /**
   * Where skills are loaded from, as a local plugin: the workbench's own root.
   * Skills belong to the workbench, never to the project being worked on, which
   * is why `settingSources` stays empty and discovery happens here instead.
   */
  pluginRoot: string;
  /**
   * What that plugin holds. One list, and every stage gets all of it: named in the
   * brief so an agent knows it is there, passed to the SDK so nothing else on the
   * machine is, and given to the guard so nothing else can be read.
   */
  skills: () => readonly SkillDef[];
  /** The change so far, shown to review and verify so they do not go looking. */
  diff: (ticket: Ticket, worktree: string) => Promise<string>;
  /** What became of the ticket this one carries on from, when it carries on from one. */
  continued: (ticketId: string) => string;
  /**
   * How a run reaches the model service. The SDK's own unless a test hands over one
   * that answers without a network; there is no other reason to set it.
   */
  query?: typeof query;
};

/**
 * How an attempt at a stage ended, and whether it ended by throwing. The result is
 * all the orchestrator ever sees — a failure comes back like any other ending, with
 * what it spent. `crashed` is for the resume fallback alone, which has to tell a
 * session that was simply gone from a run that ran and went wrong.
 */
type Attempt = { result: RunResult; crashed: boolean };

/**
 * The one place that talks to the model service. Everything above it deals in
 * tickets, stages and outcomes; nothing above it knows this SDK exists.
 */
export function createStageRunner(deps: StageRunnerDeps): StageRunner {
  return async function runStage({
    ticket,
    stage,
    runId,
    worktree,
    scratch,
    checks,
    resume,
    emit,
    signal,
  }): Promise<RunResult> {
    // The ceilings this ticket's size warrants. Small is not a hint: it is fewer
    // turns and less money, so a stage on a small ticket finishes rather than
    // exploring — reviewing t13 cost more than doing it, on every cycle.
    const agent = forScale(deps.agents()[stage], ticket.scale);
    const skills = deps.skills();
    /** The names an agent types, and the only ones the guard will answer to. */
    const skillNames = skills.map((skill) => skill.name);
    const needsDiff = stage === 'review' || stage === 'verify';

    /**
     * Built only when it is needed. A resumed run already has all of this in its
     * conversation, and assembling it means fetching the diff — so the saving is
     * not only the model's re-reading, it is ours too.
     */
    let assembled: string | undefined;
    const fullBrief = async (): Promise<string> => {
      assembled ??= buildBrief({
        ticket,
        agent,
        worktree,
        scratch,
        about: deps.about,
        skills,
        scale: ticket.scale,
        absent: deps.protectedPaths,
        map: await worktreeMap(worktree),
        diff: needsDiff ? await deps.diff(ticket, worktree) : undefined,
        checks,
        answer: ticket.answer ?? undefined,
        continues: ticket.continues === null ? undefined : deps.continued(ticket.continues),
      });
      return assembled;
    };

    /** What every attempt at this stage has cost between them. */
    let spent = 0;

    // Resuming is worth a try but must never be worth a stuck ticket. The session
    // lives in ~/.claude/projects on one machine and can simply be gone.
    if (resume !== undefined) {
      const before = spent;
      const resumed = await runOnce(carryOnFrom(ticket.answer ?? ''), resume);
      // Only fall back if the attempt got nowhere. One that spent money before
      // failing has done some of the work, and re-running it would pay twice —
      // which is the very thing this whole feature exists to stop. Anything that
      // ran and ended, however badly, is this stage's answer.
      if (!resumed.crashed || spent > before) return resumed.result;
      emit({
        type: 'agent_said',
        runId,
        text: `could not pick the ${stage} run back up (${resumed.result.summary}) — starting this stage again from the top`,
      });
    }

    return (await runOnce(await fullBrief())).result;

    async function runOnce(prompt: string, resumeFrom?: string): Promise<Attempt> {
      /** Set when the agent asks the manager something. Ends the run. */
      let asked: RunResult['question'];
      /** The conversation this run is, so answering a question can continue it. */
      let sessionId: string | undefined;

      /**
       * The hook has to reach the query to stop a run, and the query needs the hook
       * to exist before it is created, so one of the two is assigned late.
       */
      let session: ReturnType<typeof query> | undefined;

      // The SDK wants a controller; the orchestrator owns the signal, so it drives one.
      const abortController = new AbortController();
      const relayAbort = () => abortController.abort();
      signal.addEventListener('abort', relayAbort, { once: true });
      if (signal.aborted) relayAbort();

      const options: Options = {
        ...(resumeFrom !== undefined ? { resume: resumeFrom } : {}),
        cwd: worktree,
        model: agent.model,
        effort: agent.effort,
        permissionMode: agent.permissionMode,
        allowedTools: [...agent.allowedTools],
        disallowedTools: [...agent.disallowedTools],
        maxTurns: agent.maxTurns,
        maxBudgetUsd: agent.maxBudgetUsd,
        abortController,
        // Skills come from the workbench, not from the project being worked on: no
        // filesystem settings, and a plugin rooted where the workbench keeps its own.
        settingSources: [],
        plugins: [{ type: 'local', path: deps.pluginRoot, skipMcpDiscovery: true }],
        // The workbench's own tools, and only the ones this stage was granted:
        // `allowedTools` auto-approves rather than restricts, so a server built once
        // for everyone would offer `where` to a stage that cannot call it, and the
        // stage would spend a turn finding that out. Built here rather than outside
        // the closure because tickets run concurrently and each holds its own worktree.
        mcpServers: wbServer(
          { worktree, scratch, protectedPaths: deps.protectedPaths },
          agent.allowedTools,
        ),
        // Nothing from this machine, for the same reason `settingSources` is empty.
        strictMcpConfig: true,
        env: { ...process.env, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
        // Named one by one, because this option is a context filter and `[]` does not
        // mean "none" — it means "no filter", which is how every stage came to be
        // offered `doctor` from the machine it happened to be running on. It is also
        // what puts `Skill(<name>)` in the granted tools, so a stage can read what it
        // is told it has. The guard is the wall; this is only what gets advertised.
        skills: skillNames,

        hooks: {
          PreToolUse: [
            {
              hooks: [
                toolHook({
                  agent,
                  runId,
                  worktree,
                  scratch,
                  protectedPaths: deps.protectedPaths,
                  skills: skillNames,
                  emit,
                  onQuestion: (question) => {
                    asked = question;
                    void session?.interrupt().catch(() => {});
                  },
                }),
              ],
            },
          ],
        },

        // Everything the hook did not settle. Nothing should reach here; a tool that
        // does is one nobody granted.
        canUseTool: async (toolName): Promise<PermissionResult> => {
          return {
            behavior: 'deny',
            message: `${toolName} is not available to this stage`,
          };
        },
      };

      let finalText = '';
      let stopped: string | undefined;
      /** How the run went wrong, when it went wrong by throwing. */
      let threw: string | undefined;

      session = (deps.query ?? query)({ prompt, options });

      try {
        for await (const message of session) {
          sessionId ??= message.session_id;
          if (message.type === 'system' && message.subtype === 'init') {
            // What the run is actually working with. Worth one line in the record: it is
            // the only place that says which credential was used and whether the skills
            // this stage asked for were really there.
            const held = message.skills.length > 0 ? message.skills.join(', ') : 'none';
            const plugins =
              message.plugins.length > 0 ? message.plugins.map((p) => p.name).join(', ') : 'none';
            emit({
              type: 'agent_said',
              runId,
              text: `[${stage}] credential: ${message.apiKeySource} · skills: ${held} · plugins: ${plugins}`,
            });
          } else if (message.type === 'assistant') {
            const text = textOf(message.message.content);
            if (text !== '') emit({ type: 'agent_said', runId, text });
          } else if (message.type === 'result') {
            spent += message.total_cost_usd;
            if (message.subtype === 'success') finalText = message.result;
            else stopped = message.subtype;
          }
        }
      } catch (error) {
        // Interrupting a run to ask a question makes the SDK throw. Letting that
        // escape loses `asked` — the question is captured, the run stops, and the
        // manager is never told, which is the whole mechanism failing at the last
        // inch. A throw only means something went wrong if nobody asked anything.
        if (!asked) threw = describe(error);
      }

      // Whatever happened, every attempt at this stage cost what it cost.
      const costUsd = spent;
      const ended = (result: RunResult): Attempt => ({ result, crashed: false });

      // The session is kept only when there is something to come back to. Any other
      // ending is the end of the run, and a stale id would invite a resume of a
      // conversation that has nothing left to say.
      if (asked) {
        return ended({
          outcome: 'blocked',
          summary: 'waiting on the manager',
          question: asked,
          sessionId,
          costUsd,
        });
      }
      if (signal.aborted) {
        return ended({ outcome: 'failed', summary: 'the manager stopped this run', costUsd });
      }
      // A throw is reported, not rethrown: the ticket's record needs what the run
      // spent as much as any other ending needs it, and more, because the runs that
      // throw are the expensive ones — a budget ceiling, a session limit. Letting it
      // out of here means the orchestrator only has the error, and the money the run
      // burned before hitting it is charged to nobody.
      if (threw !== undefined) {
        return { result: { outcome: 'failed', summary: threw, costUsd }, crashed: true };
      }
      if (stopped !== undefined) {
        return ended({ outcome: 'failed', summary: `the run stopped: ${stopped}`, costUsd });
      }

      return ended({
        outcome: 'completed',
        summary: finalText,
        ...readApproval(stage, finalText),
        ...readScale(stage, finalText),
        ...readSteps(stage, finalText),
        ...readDoneWhen(stage, finalText),
        ...readLater(finalText),
        costUsd,
      });
    }
  };
}

/**
 * The shape of the worktree, for the brief.
 *
 * Nothing here is allowed to stop a stage: an index is an economy, not a requirement,
 * and a ticket that will not start because a parser fell over would be a worse problem
 * than the turns this saves. A failure means the stage orients the old way.
 */
async function worktreeMap(worktree: string): Promise<string | undefined> {
  try {
    return fileMap(await indexTree(worktree));
  } catch {
    return undefined;
  }
}

/**
 * What a resumed run is sent. Deliberately short: the conversation already holds
 * the ticket, the plan, the diff and everything the agent had read when it stopped.
 * Rebuilding the brief would be paying a second time for thinking already done —
 * a re-planned interruption cost $0.16 for a plan that already existed.
 */
function carryOnFrom(answer: string): string {
  return [
    'The manager has answered the question you stopped to ask:',
    '',
    answer,
    '',
    'Carry on from where you stopped. You already have the ticket, everything you',
    'had read and the work you had done — do not start again.',
  ].join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a stage may do, decided before every tool call — including ones the SDK
 * would auto-approve, which is why this is a hook and not `canUseTool`. Every
 * call is recorded whether or not it is allowed; the refused ones are the more
 * interesting half of the record.
 */
function toolHook(args: {
  agent: AgentDef;
  /** The stage run this hook is recording for. */
  runId: string;
  worktree: string;
  scratch: string;
  protectedPaths: readonly string[];
  /** The workbench's skills, by canonical name: the only ones `Skill` may read. */
  skills: readonly string[];
  emit: (body: EventBody) => void;
  /** The agent asked the manager something. Ends the run. */
  onQuestion: (question: NonNullable<RunResult['question']>) => void;
}): HookCallback {
  const { agent, runId, worktree, scratch, protectedPaths, skills, emit, onQuestion } = args;

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const record = (allowed: boolean, reason?: string) =>
      emit({
        type: 'tool_requested',
        runId,
        tool: input.tool_name,
        input: input.tool_input,
        allowed,
        reason,
      });

    // Asking is not a call to allow or refuse — it ends the run. This is how
    // "never assume — ask" gets out of the agent and into the state machine. It
    // cannot live in canUseTool: a tool named in allowedTools is auto-approved
    // before that callback is ever consulted, so the question would be answered
    // by nobody and the agent would carry on.
    if (input.tool_name === 'AskUserQuestion') {
      onQuestion(readQuestion(input.tool_input));
      record(false, 'asking the manager');
      return deny('asking the manager');
    }

    const verdict = guard(
      {
        worktree,
        scratch,
        allowedTools: agent.allowedTools,
        protectedPaths,
        skills,
      },
      input.tool_name,
      input.tool_input,
    );

    record(verdict.allow, verdict.allow ? undefined : verdict.reason);
    return verdict.allow ? {} : deny(verdict.reason);
  };
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

export function readQuestion(input: unknown): NonNullable<RunResult['question']> {
  const questions = (input as Record<string, unknown> | null)?.['questions'];
  const first = Array.isArray(questions) ? questions[0] : undefined;
  if (first && typeof first === 'object') {
    const q = first as Record<string, unknown>;
    return {
      question: typeof q['question'] === 'string' ? q['question'] : JSON.stringify(input),
      reasoning: typeof q['header'] === 'string' ? q['header'] : '',
    };
  }
  return { question: JSON.stringify(input), reasoning: '' };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      return typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text';
    })
    .map((b) => b.text)
    .join('')
    .trim();
}
