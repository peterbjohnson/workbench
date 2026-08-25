import type { Scale, Stage } from '../domain/events.ts';

/**
 * What a stage says to the workbench, and how the workbench reads it.
 *
 * Four markers, all of them plain lines in what an agent writes: the verdict, the
 * scale, the steps, and which step it has reached. Kept apart from the runner that
 * talks to the model service, because it is a protocol rather than a runtime — the
 * orchestrator reads announcements too, and must not drag an SDK in to do it.
 */

/**
 * The plan ends with `SCALE: small|standard|large` on its own line, saying how much
 * it judged the work to warrant.
 *
 * **Silence means `standard`**, never `small` — the same principle as an unreadable
 * verdict counting as a rejection. A plan that forgets to say, or says something
 * unreadable, must not thereby buy itself a lighter review.
 */
export function readScale(stage: Stage, text: string): { scale?: Scale } {
  if (stage !== 'plan') return {};

  for (const line of text.trimEnd().split('\n').reverse()) {
    const declared = /^SCALE:\s*(small|standard|large)\s*$/i.exec(line.trim());
    if (declared?.[1]) return { scale: declared[1].toLowerCase() as Scale };
  }
  return { scale: 'standard' };
}

/**
 * The plan ends with a `STEPS:` block, one numbered step per line, saying what the
 * work breaks into. They are what the implement stage reports progress against, so
 * a running ticket can say where it has got to rather than only that it is running.
 *
 * A plan that does not say gets no steps and loses nothing: the board falls back to
 * what it showed before, which is the stage and its tool calls.
 */
export function readSteps(stage: Stage, text: string): { steps?: string[] } {
  if (stage !== 'plan') return {};
  const steps = listUnder(text, /^STEPS:$/i);
  return steps.length > 0 ? { steps } : {};
}

/**
 * The plan says what would make this ticket finished, as a `DONE WHEN:` list. It
 * is shown at the gate, so approving the plan agrees the finish line — and review
 * judges against it rather than against its own taste.
 *
 * Without it a reviewer is answering "is this as good as it could be", which has
 * no end. Both of the first real tickets died of that question.
 */
export function readDoneWhen(stage: Stage, text: string): { doneWhen?: string[] } {
  if (stage !== 'plan') return {};
  const doneWhen = listUnder(text, /^DONE WHEN:$/i);
  return doneWhen.length > 0 ? { doneWhen } : {};
}

/**
 * Improvements a stage noticed that are not this ticket's job, as a `LATER:` list.
 * Somewhere for "this could be better" to go that is not the verdict: the manager
 * turns one into a ticket with a click, or ignores it for nothing.
 */
export function readLater(text: string): { later?: string[] } {
  const later = listUnder(text, /^LATER:$/i);
  return later.length > 0 ? { later } : {};
}

/**
 * The items listed under a heading — numbered or bulleted, to the first line that
 * is neither. Blank lines inside a list are skipped; anything else ends it, so a
 * trailing `SCALE:` or a closing paragraph cannot become an item.
 *
 * An indented line carries on the item above it, because an item long enough to say
 * something is an item long enough to wrap — and a wrapped one used to end the list
 * where it wrapped, taking every item after it with it.
 */
function listUnder(text: string, heading: RegExp): string[] {
  const lines = text.trimEnd().split('\n');
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line);
    if (item?.[1] !== undefined) items.push(item[1].trim());
    else if (line.trim() === '') continue;
    else if (/^\s/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
    else break;
  }
  return items;
}

/**
 * `STEP <n>` on a line of its own, as a stage announces where it has got to. The
 * last one in the message wins, so an agent that says it has finished one step and
 * started the next in the same breath is recorded at the further of the two.
 */
export function readStep(text: string): number | undefined {
  let reached: number | undefined;
  for (const line of text.split('\n')) {
    const announced = /^STEP\s+(\d+)\b/i.exec(line.trim());
    if (announced?.[1]) reached = Number(announced[1]);
  }
  return reached;
}

/**
 * Review and verify end with one of three verdicts:
 *
 * - `APPROVED` — nothing here should stop this.
 * - `CHANGES:` and a list — the approach is right, these things are wrong. The
 *   ticket goes back to implement carrying the list.
 * - `REJECTED: <reason>` — the approach itself is wrong, and no edit to what is
 *   there will fix it. The ticket is re-planned.
 *
 * The distinction is the difference between fixing a draft and starting again.
 * Every objection the first two real tickets ever raised was of the middle kind —
 * a wrong number, a stale claim, a constraint checked at the wrong end — and each
 * one cost a whole re-planned cycle for want of somewhere to put it.
 */
export function readApproval(stage: Stage, text: string): { rejected?: string; changes?: string } {
  if (stage !== 'review' && stage !== 'verify') return {};

  const lines = text.trimEnd().split('\n');

  // All three are read the same way, from anywhere, and the last one wins — so a
  // later objection still beats an earlier approval, which is the safe direction.
  //
  // The verdict used to have to be the final non-empty line. It is a marker like
  // every other, and demanding it be last put it in competition with the `LATER:`
  // block, which the same instructions also said to end with. t17 said APPROVED,
  // listed six things for later, and was sent round again for not having voted.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = bare(lines[i] ?? '');

    if (/^APPROVED$/i.test(line)) return {};

    const rejection = /^REJECTED:\s*(.+)$/i.exec(line);
    if (rejection?.[1]) return { rejected: rejection[1].trim() };

    if (/^CHANGES:/i.test(line)) {
      const changes = readChanges(lines, i);
      if (changes !== undefined) return { changes };
    }
  }

  // Silence is not approval: an unreadable verdict sends the ticket back.
  return {
    rejected: `the ${stage} stage did not say APPROVED, CHANGES: or REJECTED`,
  };
}

/**
 * A marker line with the markdown an agent naturally writes it in taken off, so
 * `## APPROVED` and `**APPROVED**` are the vote they plainly are. The line must
 * still be nothing but the marker: this loosens how a verdict may be dressed, not
 * where one may hide.
 */
function bare(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*+\s*|\s*\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .trim();
}

/**
 * Where one block ends: at the next one. Without this a `CHANGES:` list runs to
 * the end of the message and swallows whatever follows it — which put a reviewer's
 * `LATER:` suggestions into the objections the implementer was told to fix.
 */
const NEXT_BLOCK = /^(LATER|STEPS|DONE WHEN|SCALE|CHANGES):|^(APPROVED|REJECTED:)/i;

/** The objections under a `CHANGES:` heading, in the reviewer's own words. */
function readChanges(lines: string[], start: number): string | undefined {
  const listed = [
    (lines[start] ?? '')
      .trim()
      .replace(/^CHANGES:/i, '')
      .trim(),
  ];
  for (const line of lines.slice(start + 1)) {
    if (NEXT_BLOCK.test(line.trim())) break;
    listed.push(line.trim());
  }

  const objections = listed.filter(Boolean);
  return objections.length > 0 ? objections.join('\n') : undefined;
}
