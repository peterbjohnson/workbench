import fs from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from '../config.ts';
import { loadAgents, STAGES, type AgentDef } from '../agents/load.ts';
import { USAGE } from '../cli/usage.ts';

/**
 * The parts of the documentation worked out from the code rather than typed beside it.
 *
 * A hand-written page goes stale silently: nothing fails, it simply stops being true, and
 * it is read for months before anybody notices. These are read from the source every time
 * they are written, so the only way they can be wrong is if the code is — and
 * `docs.test.ts` fails when the checked-in file no longer matches, which is what makes
 * forgetting to run this loud rather than quiet.
 *
 * Written into `docs/reference.md` between markers rather than into a file of their own,
 * so a reader gets one page and the prose around them survives.
 *
 * A diagram of the ticket lifecycle was tried here and taken out. `applyEvent` folds any
 * event onto any ticket — that is what an event log does — so walking it produced 103
 * edges between 13 statuses: what the fold tolerates, not what the workbench does. It
 * looked authoritative and said nothing. Which events the workbench actually emits in a
 * given state is decided by the orchestrator, imperatively, and cannot be enumerated by
 * running the rules. The columns table in `using-it.md` is the honest version.
 */
export const REFERENCE = path.join(PACKAGE_ROOT, 'docs', 'reference.md');

export function generated(): Record<string, string> {
  return { commands: commands(), stages: stages() };
}

/** What `wb --help` prints, so the page and the terminal cannot disagree. */
function commands(): string {
  return ['```', USAGE.trim(), '```'].join('\n');
}

/**
 * What each stage is allowed to do. Read from `agents/*.md`, which is where it is
 * decided — and which changes whenever an agent is tuned, so a copy typed beside it
 * would be wrong within a week.
 */
function stages(): string {
  const agents = loadAgents([path.join(PACKAGE_ROOT, 'agents')]);
  return [
    '| stage | model | effort | turns | budget | tools |',
    '|---|---|---|---|---|---|',
    ...STAGES.map((stage) => row(stage, agents[stage])),
  ].join('\n');
}

function row(stage: string, a: AgentDef): string {
  // The strikethrough goes outside the code span: markdown does not format inside one,
  // so `~~Glob~~` renders as tildes rather than as a refusal.
  const tools = [
    ...a.allowedTools.map((t) => `\`${t}\``),
    ...a.disallowedTools.map((t) => `~~\`${t}\`~~`),
  ].join(', ');
  return `| **${stage}** | ${a.model} | ${a.effort} | ${a.maxTurns} | $${a.maxBudgetUsd} | ${tools} |`;
}

/**
 * Puts a generated section into a document, between its markers.
 *
 * Refuses rather than appends when a marker is missing: a section that had quietly
 * stopped being written would look exactly like one that was still true.
 */
export function splice(markdown: string, name: string, body: string): string {
  const open = `<!-- generated:${name} -->`;
  const close = `<!-- /generated:${name} -->`;
  const from = markdown.indexOf(open);
  const to = markdown.indexOf(close);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${name}: no ${open} … ${close} to write into`);
  }
  return `${markdown.slice(0, from + open.length)}\n\n${body}\n\n${markdown.slice(to)}`;
}

/** The reference page as it should be, given the code as it is. */
export function reference(): string {
  let markdown = fs.readFileSync(REFERENCE, 'utf8');
  for (const [name, body] of Object.entries(generated())) {
    markdown = splice(markdown, name, body);
  }
  return markdown;
}

/** `npm run docs`. Writes it; the test is what notices when nobody did. */
if (process.argv[1] !== undefined && process.argv[1].endsWith('generate.ts')) {
  fs.writeFileSync(REFERENCE, reference());
  console.log(`wrote ${path.relative(process.cwd(), REFERENCE)}`);
}
