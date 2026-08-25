/**
 * The tools the workbench gives its agents, by name.
 *
 * This list is the single source of three things that must agree or the guardrails do
 * not hold: what `agents/*.md` may name, what the guard will answer to, and what is
 * actually registered on the MCP server. Deriving them all from here means a name
 * cannot exist in one place and be missing from another — which is how a tool comes to
 * be advertised to an agent and refused by the guard, costing a turn every time.
 *
 * No SDK import. `load.ts` reads this to validate frontmatter and must not take a
 * dependency on the agent SDK to do it.
 */

export const SERVER = 'wb';

/** What the SDK, the frontmatter and the guard all call one of these tools. */
export function qualified(name: string): string {
  return `mcp__${SERVER}__${name}`;
}

export type ToolName = 'map' | 'where';

/**
 * Every workbench tool, and whether it changes anything.
 *
 * `writes` is not documentation: the guard reads it to decide whether a call has to be
 * checked against `protectedPaths`. A writing tool added without saying so would be one
 * the guard lets edit its own guardrails.
 */
export const WB_TOOLS: readonly { name: ToolName; writes: boolean }[] = [
  { name: 'map', writes: false },
  { name: 'where', writes: false },
];

/** Every workbench tool name, qualified. What frontmatter may name. */
export const WB_TOOL_NAMES: readonly string[] = WB_TOOLS.map((t) => qualified(t.name));

/** The ones that change a file. Read from here by the guard, never restated. */
export const WB_WRITE_TOOLS: readonly string[] = WB_TOOLS.filter((t) => t.writes).map((t) =>
  qualified(t.name),
);
