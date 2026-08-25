import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import type { Scale, Stage } from '../domain/events.ts';
import { WB_TOOL_NAMES } from '../tools/names.ts';

export const STAGES: readonly Stage[] = ['plan', 'implement', 'review', 'verify'];

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk' | 'plan';

export type AgentDef = {
  stage: Stage;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  maxTurns: number;
  maxBudgetUsd: number;
  allowedTools: string[];
  disallowedTools: string[];
  /**
   * What to run this stage with when the plan judged the ticket a given size.
   * Only the ceilings vary — a small ticket gets the same job description, the
   * same tools and the same instructions, with less room to wander.
   */
  scales: Partial<Record<Scale, Ceilings>>;
  /** The markdown body: the agent's job description. */
  instructions: string;
};

/** What a stage may spend on a run, and how hard it thinks. */
export type Ceilings = {
  effort?: Effort;
  maxTurns?: number;
  maxBudgetUsd?: number;
};

/**
 * The definition to run a ticket of this size under.
 *
 * Before this, `small` bound nothing: it reached the agents as one sentence in
 * the brief while every stage ran at the same ceiling. t13's own plan called it
 * small, and reviewing it cost more than doing it — on all three cycles.
 */
export function forScale(agent: AgentDef, scale: Scale): AgentDef {
  return { ...agent, ...agent.scales[scale] };
}

/**
 * Tool names are the guardrail, so a typo must not silently widen or narrow one.
 *
 * The workbench's own tools are not listed here but derived from the registry that
 * also registers them, so `mcp__wb__where` cannot be granted in frontmatter unless
 * there is a tool of that name to grant. Extend the built-in list below when the SDK
 * offers something new; extend `WB_TOOLS` when the workbench does.
 */
const KNOWN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Skill',
  'AskUserQuestion',
  'TaskCreate',
  'TaskUpdate',
  'Agent',
  'ToolSearch',
  ...WB_TOOL_NAMES,
]);

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
const SCALES: readonly Scale[] = ['small', 'standard', 'large'];
/** What a per-scale block may set. Everything else about a stage is fixed. */
const CEILINGS = new Set(['effort', 'maxTurns', 'maxBudgetUsd']);
const MODES = new Set<string>(['default', 'acceptEdits', 'dontAsk', 'plan']);

/**
 * Reads `<stage>.md` from the first of `dirs` that has one, per stage. Throws on
 * anything it cannot vouch for.
 *
 * Per stage rather than per directory, because the four are separately useful. A
 * project rewriting `plan.md` for how it plans has said nothing about how it verifies,
 * and copying the other three so it can change one would fork them all — for a change
 * it never made and would then have to merge by hand.
 */
export function loadAgents(dirs: readonly string[]): Record<Stage, AgentDef> {
  const entries = STAGES.map((stage) => [stage, loadAgent(nearest(dirs, stage), stage)] as const);
  return Object.fromEntries(entries) as Record<Stage, AgentDef>;
}

/**
 * The first directory holding this stage. The last is returned when none does, so the
 * error naming the missing file comes from `loadAgent` and names a real path, rather
 * than being a different complaint from here about a list.
 */
function nearest(dirs: readonly string[], stage: Stage): string {
  const found = dirs.find((dir) => fs.existsSync(path.join(dir, `${stage}.md`)));
  return found ?? dirs[dirs.length - 1] ?? '';
}

export function loadAgent(dir: string, stage: Stage): AgentDef {
  return parseAgent(fs.readFileSync(path.join(dir, `${stage}.md`), 'utf8'), stage);
}

/**
 * One agent file's text, checked. Separate from reading it so the same strictness
 * can be applied to a file being *saved* — the board offers these for editing, and
 * an agent file that fails to load takes the whole workbench down at the next
 * start. Refusing it at the point it is written names the field and keeps the
 * workbench running.
 */
export function parseAgent(raw: string, stage: Stage): AgentDef {
  const { data, content } = matter(raw);
  const where = `${stage}.md`;
  const field = fields(data, where);

  const def: AgentDef = {
    stage,
    model: field.string('model'),
    effort: field.oneOf('effort', EFFORTS) as Effort,
    permissionMode: field.oneOf('permissionMode', MODES) as PermissionMode,
    maxTurns: field.number('maxTurns', { whole: true }),
    maxBudgetUsd: field.number('maxBudgetUsd'),
    allowedTools: field.tools('allowedTools'),
    disallowedTools: field.tools('disallowedTools'),
    scales: field.scales(),
    instructions: content.trim(),
  };

  if (data['stage'] !== undefined && data['stage'] !== stage) {
    throw new Error(`${where}: declares stage "${data['stage']}" but is named for "${stage}"`);
  }
  if (def.instructions === '') throw new Error(`${where}: has no instructions`);
  if (def.allowedTools.length === 0) throw new Error(`${where}: grants no tools`);

  const both = def.allowedTools.filter((t) => def.disallowedTools.includes(t));
  if (both.length > 0) {
    throw new Error(`${where}: ${both.join(', ')} is both allowed and disallowed`);
  }

  return def;
}

/**
 * A skill, as an agent has to deal with it: the exact name it types to read one,
 * and what that one is for. The description is the whole trigger — an agent picks
 * a skill by reading it — so a skill without one is a skill nobody will call.
 */
export type SkillDef = { name: string; description: string };

/**
 * Reads workbench/skills/<name>/SKILL.md. There is one list of skills and this is
 * it: every stage gets all of them. Rationing expertise per stage was a fiction —
 * the SDK's option is a context filter, not a sandbox — and its only real effect
 * was to refuse the `Skill` tool to the stages that declared none, which is how
 * t16 came to hunt the filesystem for a skill it already had.
 *
 * The plugin's name comes from its manifest rather than being spelled out here,
 * so `workbench:writing-python` is true by construction: it is the string the SDK
 * will answer to, not one this file hopes matches.
 */
export function loadSkills(pluginRoot: string): SkillDef[] {
  const dir = path.join(pluginRoot, 'skills');
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];

  // A project with no skills is a project that has not said how work of a kind is
  // done there, which is where every project starts. The manifest is asked for only
  // when there is something to name, because naming them is all it is for.
  if (found.length === 0) return [];

  const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
  if (typeof plugin.name !== 'string' || plugin.name === '') {
    throw new Error(`${manifest}: names no plugin, so no skill of it can be named either`);
  }

  return found.map((entry) => ({
    name: `${plugin.name}:${entry.name}`,
    description: parseSkill(
      fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8'),
      entry.name,
    ),
  }));
}

/**
 * One skill file's text, checked, giving back the description — which is the whole
 * trigger. Separate from reading it for the same reason `parseAgent` is: the board
 * saves these, and a skill that fails to load stops every stage.
 */
export function parseSkill(raw: string, dirName: string): string {
  const where = `skills/${dirName}/SKILL.md`;

  // technical-report's description held an unquoted colon, so its frontmatter
  // was not YAML at all and its description was never read — by anything. The
  // parser's own complaint does not name the file it was reading.
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data;
  } catch (error) {
    throw new Error(`${where}: its frontmatter is not YAML — ${(error as Error).message}`);
  }

  const description = data['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`${where}: has no description, so nothing will ever decide to read it`);
  }
  // The directory is what the name resolves to. A frontmatter name that says
  // otherwise would be advertised to agents and answer to nobody.
  if (data['name'] !== undefined && data['name'] !== dirName) {
    throw new Error(`${where}: calls itself "${data['name']}" but lives in ${dirName}/`);
  }

  return description.trim();
}

/**
 * Reads one agent file's frontmatter. Everything closes over the file and the
 * field being read, so a failure always names both — the whole point of loading
 * these strictly is that the error tells you which file to go and fix.
 */
function fields(data: Record<string, unknown>, where: string) {
  const bad = (key: string, complaint: string): never => {
    throw new Error(`${where}: ${key} ${complaint}`);
  };

  const string = (key: string): string => {
    const v = data[key];
    return typeof v === 'string' && v !== '' ? v : bad(key, 'must be a string');
  };

  const strings = (key: string): string[] => {
    const v = data[key] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      return bad(key, 'must be a list of strings');
    }
    return v as string[];
  };

  return {
    string,
    strings,

    oneOf: (key: string, allowed: Set<string>): string => {
      const v = string(key);
      return allowed.has(v) ? v : bad(key, `must be one of ${[...allowed].join(', ')}, got "${v}"`);
    },

    number: (key: string, { whole = false } = {}): number => {
      const v = data[key];
      if (typeof v !== 'number' || !(v > 0)) return bad(key, 'must be a number greater than zero');
      if (whole && !Number.isInteger(v)) return bad(key, 'must be a whole number');
      return v;
    },

    tools: (key: string): string[] => {
      const list = strings(key);
      const unknown = list.filter((t) => !KNOWN_TOOLS.has(t));
      return unknown.length === 0 ? list : bad(key, `names unknown tools: ${unknown.join(', ')}`);
    },

    /**
     * Optional per-scale ceilings: `small: { effort: high, maxTurns: 60 }`.
     * Validated exactly as the top-level fields are — a ceiling that silently
     * failed to load would be a guardrail that is not there.
     */
    scales: (): Partial<Record<Scale, Ceilings>> => {
      const out: Partial<Record<Scale, Ceilings>> = {};

      for (const scale of SCALES) {
        const block = data[scale];
        if (block === undefined) continue;
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          return bad(scale, 'must be a block of ceilings, like { effort: high, maxTurns: 60 }');
        }

        const given = block as Record<string, unknown>;
        const unknown = Object.keys(given).filter((k) => !CEILINGS.has(k));
        if (unknown.length > 0) {
          return bad(scale, `may only set ${[...CEILINGS].join(', ')} — not ${unknown.join(', ')}`);
        }

        const ceilings: Ceilings = {};
        for (const [key, value] of Object.entries(given)) {
          if (key === 'effort') {
            if (typeof value !== 'string' || !EFFORTS.has(value)) {
              return bad(`${scale}.effort`, `must be one of ${[...EFFORTS].join(', ')}`);
            }
            ceilings.effort = value as Effort;
          } else {
            if (typeof value !== 'number' || !(value > 0)) {
              return bad(`${scale}.${key}`, 'must be a number greater than zero');
            }
            if (key === 'maxTurns' && !Number.isInteger(value)) {
              return bad(`${scale}.maxTurns`, 'must be a whole number');
            }
            ceilings[key as 'maxTurns' | 'maxBudgetUsd'] = value;
          }
        }
        out[scale] = ceilings;
      }

      return out;
    },
  };
}
