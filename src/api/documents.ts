import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.ts';
import type { Stage } from '../domain/events.ts';
import { CHAT_AGENT, parseAgent, parseChatAgent, parseSkill, STAGES } from '../agents/load.ts';

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

/**
 * A skill that was not there before: a directory with a `SKILL.md` in it, because that
 * is the whole of what a skill is. Given no text, it starts from a file that loads —
 * an empty one would be a skill nothing could read and every stage would refuse.
 *
 * Agents are the four stages, which are fixed, so there is nothing here to make.
 */
export function createDoc(config: Config, kind: DocKind, name: string, text?: string): Doc {
  onlySkills(kind);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`"${name}" is not a skill name — lowercase letters, digits and dashes`);
  }
  if (names(config, kind).includes(name))
    throw new Error(`there is already a skill called ${name}`);

  const body = text ?? starter(name);
  describe(kind, name, body);

  ensurePluginManifest(config);
  const dir = path.join(skillsDir(config), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body.endsWith('\n') ? body : `${body}\n`);
  return readDoc(config, kind, name);
}

/**
 * Gone, directory and all — a skill is its directory, so leaving the rest of it behind
 * would leave a half-skill on disk that nothing lists and nobody can edit.
 *
 * What may be removed is what is listed, not what `createDoc` would allow as a new name:
 * a skill directory made by hand can be called `writing_python`, and one the board shows,
 * saves and offers a Delete button for has to be one Delete removes. Being in the list is
 * also what makes the join safe — the only names there are directories in `skills/` — so
 * all that is left to check is a name that never came from the list at all.
 */
export function deleteDoc(config: Config, kind: DocKind, name: string): void {
  onlySkills(kind);
  if (/[/\\]/.test(name) || name === '.' || name === '..') {
    throw new Error(`"${name}" is not a skill name — it is a path`);
  }
  if (!names(config, kind).includes(name)) throw new Error(`no ${kind} called ${name}`);
  fs.rmSync(path.join(skillsDir(config), name), { recursive: true });
}

function onlySkills(kind: DocKind): void {
  if (kind === 'agent')
    throw new Error('the four stages are fixed — an agent is not yours to add or remove');
}

/**
 * A first draft that loads: the name it answers to, and a description to replace. The
 * name is quoted because a directory called `2024` or `null` is a name YAML would
 * otherwise read as a number or nothing, and the skill would refuse to load as one
 * calling itself something other than where it lives.
 */
function starter(name: string): string {
  return [
    '---',
    `name: "${name}"`,
    `description: What ${name} covers, and when a stage should read it. Replace this — it is the whole trigger.`,
    '---',
    '',
    `# ${name}`,
    '',
    'What good looks like for work of this kind, here.',
    '',
  ].join('\n');
}

/**
 * Skills reach an agent as a local plugin, and a plugin is its manifest: `loadSkills`
 * refuses to name a skill without one. `wb init` writes it for that reason, but a home
 * made before it did, or by hand, has none — and there the first skill added would stop
 * every stage of every ticket.
 */
function ensurePluginManifest(config: Config): void {
  const file = path.join(config.pluginRoot, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        name: 'workbench',
        version: '0.0.0',
        description: "This repository's own skills, loaded into the agents the workbench runs.",
      },
      null,
      2,
    )}\n`,
  );
}

/** What a document says about itself, which is also the check that it is valid. */
function describe(kind: DocKind, name: string, text: string): string {
  if (kind === 'skill') return parseSkill(text, name);
  // The chat agent is not a stage, so it is checked by its own reader — but it is an
  // agent file, and editing it in the board is the same act as editing the other four.
  const agent = name === CHAT_AGENT ? parseChatAgent(text) : parseAgent(text, name as Stage);
  return `${agent.model} · ${agent.effort} effort · ${agent.maxTurns} turns · $${agent.maxBudgetUsd}`;
}

/** The names there are. Nothing outside this list is readable or writable. */
function names(config: Config, kind: DocKind): string[] {
  if (kind === 'agent') return [...STAGES, CHAT_AGENT];
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
