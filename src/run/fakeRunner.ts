import fs from 'node:fs/promises';
import path from 'node:path';

import type { Stage } from '../domain/events.ts';
import type { AgentDef } from '../agents/load.ts';
import type { RunResult, StageRunner } from '../orchestrator/loop.ts';
import { guard } from './guard.ts';

/**
 * A stage runner that makes no external calls: no model service, no credentials,
 * no cost. It does real work on disk so worktrees, commits and diffs are genuine —
 * everything except the thinking is the real thing.
 *
 * Its tool calls go through the same guard as a real agent's, with the same tool
 * lists, so the refusal path is exercised too.
 *
 * It always succeeds. Making a stage reject, ask or fail is what the orchestrator's
 * own test harness is for; doing it here as well would be a second way to say the
 * same thing, against a runner whose point is that it is not the interesting part.
 */
export function createFakeRunner(opts: {
  /** The shipped definitions, so a fake stage is granted exactly what a real one is. */
  agents: () => Record<Stage, AgentDef>;
  protectedPaths?: readonly string[];
}): StageRunner {
  return async function fakeStage({
    ticket,
    stage,
    runId,
    worktree,
    scratch,
    emit,
    signal,
  }): Promise<RunResult> {
    if (signal.aborted) {
      return { outcome: 'failed', summary: 'the manager stopped this run' };
    }

    const ctx = {
      worktree,
      scratch,
      allowedTools: opts.agents()[stage].allowedTools,
      protectedPaths: opts.protectedPaths,
    };

    /** Mimics an agent asking to use a tool: checked, recorded, then done. */
    const useTool = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
      const verdict = guard(ctx, tool, input);
      emit({
        type: 'tool_requested',
        runId,
        tool,
        input,
        allowed: verdict.allow,
        reason: verdict.allow ? undefined : verdict.reason,
      });
      return verdict.allow;
    };

    emit({ type: 'agent_said', runId, text: `[fake ${stage}]` });

    switch (stage) {
      case 'plan':
        // Not Glob: the brief already lists every file, so no stage is offered one.
        await useTool('Grep', { pattern: 'TODO' });
        return {
          outcome: 'completed',
          // A real plan declares both of these, so this one does too — otherwise
          // the paths that read them are never exercised without spending money.
          summary: [
            `Plan for "${ticket.title}": add a note recording the ticket.`,
            '',
            'STEPS:',
            '1. Read what is there',
            '2. Write the note',
            '3. Check it says the right thing',
            '',
            'SCALE: small',
          ].join('\n'),
          scale: 'small',
          steps: ['Read what is there', 'Write the note', 'Check it says the right thing'],
        };

      case 'implement': {
        const file = path.join('fake-work', `${ticket.id}.md`);
        // Announced the way a real stage announces them, through what it says.
        emit({ type: 'agent_said', runId, text: 'STEP 1' });
        if (!(await useTool('Write', { file_path: file }))) {
          return { outcome: 'failed', summary: 'the guard refused the only write I needed' };
        }
        emit({ type: 'agent_said', runId, text: 'STEP 2' });
        const full = path.join(worktree, file);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, `# ${ticket.title}\n\n${ticket.body}\n`);
        emit({ type: 'agent_said', runId, text: 'STEP 3' });
        return { outcome: 'completed', summary: `Wrote ${file}.` };
      }

      case 'review':
        await useTool('Read', { file_path: path.join('fake-work', `${ticket.id}.md`) });
        return { outcome: 'completed', summary: 'Read the diff. Nothing to object to.\nAPPROVED' };

      case 'verify':
        await useTool('Bash', { command: 'echo no checks configured' });
        return { outcome: 'completed', summary: 'Nothing to run and nothing broke.\nAPPROVED' };
    }
  };
}
