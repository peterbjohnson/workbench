import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.ts';
import type { Stage } from '../domain/events.ts';
import { parseAgent, parseSkill, STAGES } from '../agents/load.ts';

/**
 * The two kinds of writing the workbench runs on: what each stage is told to do,
 * and the expertise every stage is handed. Both are markdown files on disk, so the
 * board reads and writes them as one thing rather than as two.
 */
export type DocKind = 'agent' | 'skill';

export type Doc = {
  kind: DocKind;
  /** What it is called: a stage, or a skill's directory. */
  name: string;
  /** The file, relative to the workbench home — what to open if you want to edit it by hand. */
  where: string;
  /** One line from what the file itself declares. Never invented. */
  about: string;
  text: string;
};

/**
 * Every document of a kind, in a fixed order — the four stages in the order they
 * run, and skills as the disk lists them.
 */
export function listDocs(config: Config, kind: DocKind): Doc[] {
  return names(config, kind).map((name) => readDoc(config, kind, name));
}

export function readDoc(config: Config, kind: DocKind, name: string): Doc {
  const file = fileFor(config, kind, name);
  const text = fs.readFileSync(file, 'utf8');
  return {
    kind,
    name,
    where: path.relative(config.home, file),
    about: describe(kind, name, text),
    text,
  };
}

/**
 * Saves it, having first checked it loads. A document that fails to parse stops
 * every stage of every ticket, so it is refused here — where the complaint names
 * the field and reaches the person who just typed it — rather than at the next
 * start, where it is a dead workbench and a stack trace.
 *
 * Agents are written to the project's own agent directory whatever they were read
 * from, so editing one the workbench ships with makes this project's version of it
 * rather than changing it for every project.
 */
export function writeDoc(config: Config, kind: DocKind, name: string, text: string): Doc {
  if (!names(config, kind).includes(name)) throw new Error(`no ${kind} called ${name}`);
  describe(kind, name, text);

  const file =
    kind === 'agent' ? path.join(ownAgentDir(config), `${name}.md`) : fileFor(config, kind, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  return readDoc(config, kind, name);
}

/** What a document says about itself, which is also the check that it is valid. */
function describe(kind: DocKind, name: string, text: string): string {
  if (kind === 'skill') return parseSkill(text, name);
  const agent = parseAgent(text, name as Stage);
  return `${agent.model} · ${agent.effort} effort · ${agent.maxTurns} turns · $${agent.maxBudgetUsd}`;
}

/** The names there are. Nothing outside this list is readable or writable. */
function names(config: Config, kind: DocKind): string[] {
  if (kind === 'agent') return [...STAGES];
  return fs
    .readdirSync(skillsDir(config), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(skillsDir(config), entry.name, 'SKILL.md')),
    )
    .map((entry) => entry.name)
    .sort();
}

function fileFor(config: Config, kind: DocKind, name: string): string {
  if (!names(config, kind).includes(name)) throw new Error(`no ${kind} called ${name}`);
  if (kind === 'skill') return path.join(skillsDir(config), name, 'SKILL.md');

  // The same search the runner does: the project's own agents, then the ones that
  // ship with the workbench. What is edited is what is being run.
  const dir = config.agentDirs.find((d) => fs.existsSync(path.join(d, `${name}.md`)));
  if (dir === undefined) throw new Error(`no agent file for ${name}`);
  return path.join(dir, `${name}.md`);
}

function skillsDir(config: Config): string {
  return path.join(config.pluginRoot, 'skills');
}

function ownAgentDir(config: Config): string {
  return config.agentDirs[0] ?? path.join(config.home, 'agents');
}
