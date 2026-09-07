/**
 * How the panel says what a blocked branch will not merge with. Two clashes park a
 * ticket the same way and read the same way, and they are not the same thing: the
 * base moving on is nobody's doing, and a clash with a branch this ticket waits for
 * is that dependency's work sitting under this one. The brief is the half that
 * matters — it is what the implement run sent back is handed, and a run told the
 * base moved on when it did not starts from a wrong account of what it is resolving.
 *
 * Here rather than in the panel so the wording can be tested without a browser, and
 * phrased from `conflictedWith` rather than from the reason, which is prose.
 */

import type { Ticket } from './ticket.ts';

/** Whether the clash was with the base itself, as opposed to work waited for. */
const withTheBase = (t: Ticket): boolean =>
  t.conflictedWith === null || t.conflictedWith.ref === t.conflictedWith.base;

/**
 * The box's heading. A ticket blocked before what the clash was with was recorded
 * has only the old, unqualified heading to fall back on.
 */
export function conflictHeading(t: Ticket): string {
  if (t.conflictedWith === null) return 'Conflicts with the base';
  return withTheBase(t)
    ? `Conflicts with the base at ${t.conflictedWith.base.slice(0, 8)}`
    : `Conflicts with ${t.conflictedWith.ref}, the work this ticket waits for`;
}

/** What the "send back to resolve them" button asks implement for. */
export function conflictBrief(t: Ticket): string {
  const opening = withTheBase(t)
    ? 'The base has moved on and this branch no longer merges into it.'
    : `This branch no longer merges with ${t.conflictedWith?.ref}, the work it waits for.`;
  return `${opening} Resolve the conflicts in:\n${t.conflicts.map((p) => `- ${p}`).join('\n')}`;
}
