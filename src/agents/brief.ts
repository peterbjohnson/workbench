import type { CheckRun, Event, Scale } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import type { AgentDef, SkillDef } from './load.ts';

export type BriefInput = {
  ticket: Ticket;
  agent: AgentDef;
  /**
   * Where the agent is working. Told rather than discovered: every live stage so
   * far has opened by reading the main checkout, being refused, working out that
   * it is in a worktree, and reading the same files again — four wasted tool calls
   * in review, two in plan, on a ticket with two files in it. The guard is right to
   * refuse; the agent was never told.
   */
  worktree: string;
  /**
   * What this project is, stated once rather than rediscovered per ticket. Verify
   * hunted for CI configuration that does not exist, tried `pytest --collect-only`,
   * and grepped the tree for references — all of it learning a shape that is the
   * same for every ticket.
   */
  about?: string;
  /**
   * Where working-out goes. Told only to the stages that can write: an agent with
   * nowhere to put a probe puts it in the worktree, and it ships.
   */
  scratch?: string;
  /** Directories that are deliberately absent from that worktree. */
  absent?: readonly string[];
  /**
   * Every file in the worktree and what is in it, worked out from the source before
   * the stage starts. Plan spends a quarter of its tool calls on `Glob` and review an
   * eighth, both of them learning a shape that is the same every ticket — and a turn
   * spent learning it costs the whole context, not the few hundred bytes it returns.
   */
  map?: string;
  /**
   * The expertise this stage is holding, and the names it types to read it. Loaded
   * into every session and never mentioned: t16 was told to follow a skill, looked
   * for it as a file, was refused every path it tried, and stopped to ask — having
   * had the thing all along. A tool nobody knows about is a tool nobody uses.
   */
  skills?: readonly SkillDef[];
  /** The change so far. Given to review and verify; they do not go looking for it. */
  diff?: string;
  /**
   * The standing checks the workbench has already run, and their output. Given to
   * verify, which therefore never runs them itself — it only ever sees this when
   * they all passed, because a failure sends the ticket back before any agent runs.
   */
  checks?: readonly CheckRun[];
  /**
   * A merge the workbench started before this stage and could not finish. It is in
   * the worktree, and finishing it is the first thing this stage does.
   */
  conflict?: { base: string; paths: readonly string[] };
  /** The manager's answer, when this run is resuming a blocked ticket. */
  answer?: string;
  /**
   * What an earlier ticket left here, and why it stopped. Its work is already in
   * this worktree — it is what the branch was cut from — so the danger is not that
   * the agent cannot find it but that it does not realise it is there, and writes
   * the whole thing again. Whatever stopped that ticket is the most valuable thing
   * this one can be told, because otherwise it is rediscovered at full price.
   */
  continues?: string;
  /** How much the plan judged the work to warrant. Not shown to the plan itself. */
  scale?: Scale;
};

/**
 * Assembles what one stage is told. Sections are omitted when empty rather than
 * included as "none", so an agent never reads a heading with nothing under it.
 */
export function buildBrief(input: BriefInput): string {
  const { ticket, agent } = input;

  const sections: [string, string | undefined][] = [
    ['About this project', nested(input.about)],
    ['Where you are working', whereYouAre(input)],
    ['A merge to finish first', mergeToFinish(input)],
    ['What is in the worktree', worktreeMap(input.map)],
    ['What you know how to do', skillsHeld(input.skills)],
    ['Ticket', `${ticket.title}\n\n${ticket.body}`.trim()],
    ['What you are carrying on from', input.continues],
    ['Why this came back', ticket.rejection ?? undefined],
    ['The plan they rejected', rejectedPlanFor(agent, ticket)],
    ['Changes to make', changesFor(agent, ticket)],
    ['The approved plan', planFor(agent, ticket)],
    ['Completion criteria', completionCriteriaFor(agent, ticket)],
    ['Answer to your question', input.answer],
    ['How much this warrants', declaredScale(input)],
    ['The change so far', fenced(input.diff, 'diff')],
    ['Checks already run', checksRun(input.checks)],
  ];

  const body = sections
    .filter((s): s is [string, string] => s[1] !== undefined && s[1] !== '')
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join('\n\n');

  return `${agent.instructions}\n\n---\n\n${body}\n`;
}

/**
 * What became of a ticket, for the one carrying on from it. Its commits are the
 * branch this ticket started on, so the work is already here; what is not here,
 * and is worth more than the work, is why it stopped — every objection it drew is
 * the first thing the next attempt should answer.
 *
 * This is the only way any of it travels. The objections are events in a database
 * the worktrees deliberately cannot see, so an agent that is not told cannot find
 * out, however hard it looks.
 */
export function whatHappenedTo(ticket: Ticket, events: readonly Event[]): string {
  const ended = [...events].reverse().find((e) => e.type === 'cancelled' || e.type === 'gave_up');

  const lines = [
    `**${ticket.id} — ${ticket.title}**`,
    '',
    `Its work is already in this worktree: ${ticket.commits.length} commit(s) on the branch`,
    'you started from. Read it before you write anything. You are carrying it on, not',
    'writing it again.',
  ];

  if (ticket.body.trim() !== '') lines.push('', 'What it was asked to do:', '', ticket.body.trim());
  if (ended) lines.push('', `It stopped: ${ended.reason}`);

  const objections = events.flatMap((e) =>
    e.type === 'stage_finished' && e.rejected !== undefined ? [e.rejected] : [],
  );

  if (objections.length === 1) {
    lines.push('', 'The objection to it:', '', ...objections);
  } else if (objections.length > 1) {
    // All of them, in order, not just the last. A ticket rejected three times is
    // usually rejected three times for the same thing, and that it recurred is
    // worth more than any one of them — the last one alone reads as bad luck.
    lines.push('', `Objected to ${objections.length} times, in order:`);
    lines.push(...objections.flatMap((reason, i) => ['', `${i + 1}. ${reason}`]));
  }

  return lines.join('\n');
}

function whereYouAre({ worktree, scratch, absent, agent }: BriefInput): string {
  const lines = [
    `\`${worktree}\``,
    '',
    'This is a git worktree of its own, and everything you do happens inside it.',
    'Paths outside it are refused — including the main checkout of this same',
    'repository, which is a different directory with the same files in it.',
  ];

  if (absent !== undefined && absent.length > 0) {
    lines.push(
      '',
      `Deliberately not here: ${absent.map((p) => `\`${p}\``).join(', ')}. Left out of`,
      'this worktree on purpose, not missing by accident. Do not go looking for it.',
    );
  }

  if (scratch !== undefined && canWrite(agent)) {
    lines.push(
      '',
      `Working-out goes in \`${scratch}\`, which is writable and is **not** part of`,
      'what gets committed. Put throwaway probes, scratch clones and anything else',
      'you only want in order to find something out there, not in the worktree —',
      'the worktree is the change, and everything left in it ships.',
      'You do not have to tidy it up afterwards. That is the point of it.',
    );
  }

  return lines.join('\n');
}

/**
 * The merge the workbench started for this stage and could not finish.
 *
 * It is given to the agent about to work on those files because that is the one
 * moment resolving it is cheap: two tickets cut from the same commit found their
 * clash only when they were offered, after implement and verify had both run to
 * completion, and a resolution that was minutes of work became a person's problem
 * a day later in another repository.
 */
function mergeToFinish({ conflict, agent }: BriefInput): string | undefined {
  if (conflict === undefined || conflict.paths.length === 0) return undefined;

  const lines = [
    `The base moved on to ${conflict.base.slice(0, 8)} while this ticket was being worked`,
    'on, and taking it in did not go cleanly. The merge is in your worktree right now,',
    'with `MERGE_HEAD` set, and these files hold both sides:',
    '',
    ...conflict.paths.map((p) => `- \`${p}\``),
    '',
    'Resolve them before you do anything else, by editing the files, and `git add` each',
    'one once it is right — staging it is what tells git the path is settled, and it is',
    'the only git command here that can: `git merge`, `git checkout`, `git reset` and',
    '`git commit` are all refused, so there is no way to make this go away except to read',
    'both sides and decide. Usually both are wanted and the answer is a union of the two.',
    'You are being asked because you have the change in your head, which nobody looking',
    'at this tomorrow will.',
    '',
    'This stage cannot finish until they are resolved: a run that ends with any of them',
    'still unmerged, or still holding conflict markers, is blocked and commits nothing.',
  ];

  // Verify is told, every time, that the workbench has already run the standing
  // checks. It has not for this one — they cannot be asked of a tree full of
  // markers — and a brief that leaves that claim standing sends the stage looking
  // for output that was never produced.
  if (agent.stage === 'verify') {
    lines.push(
      '',
      'Your instructions say the standing checks have already been run. Not for this stage:',
      'they cannot be asked of a tree that is mid-merge, so there is no `Checks already run`',
      'section below. The workbench runs them once this stage is over, and a failure then',
      'sends the ticket back whatever verdict you gave — so run them yourself, once the',
      'merge is resolved, if you want to know what they are going to say.',
    );
  }

  return lines.join('\n');
}

/**
 * Every file, and what is defined in it. Worked out from the source, so it is true
 * rather than remembered, and free to an agent — the cost was paid before the run
 * started, by a parser rather than by a turn.
 *
 * File-level on purpose. Every symbol in this repository is about 900 lines, which is
 * worth its context only to the stage about to change one of them; what every stage
 * needs is to stop asking which files exist.
 */
function worktreeMap(map: string | undefined): string | undefined {
  if (map === undefined || map.trim() === '') return undefined;

  return [
    'Worked out from the source just now, so it is what is actually there. Listing',
    'files is a turn you do not have to spend.',
    '',
    '```',
    map.trim(),
    '```',
  ].join('\n');
}

/**
 * The workbench's own expertise, named so it can be read. This is how the project
 * says what good looks like for work of a kind, and it is worth more than anything
 * a stage would work out for itself in the same number of turns.
 *
 * Every stage gets all of it. Review has to judge a report against the standard
 * implement wrote it to, so handing them different expertise would be arranging a
 * disagreement.
 */
function skillsHeld(skills: readonly SkillDef[] | undefined): string | undefined {
  if (skills === undefined || skills.length === 0) return undefined;

  return [
    'Read one with the `Skill` tool, by the name in bold, **before** doing work of',
    'that kind — not afterwards to check. They are held by the workbench, not kept',
    'in this worktree: there is no file to find, and looking for one is refused.',
    'A ticket that names "the X SKILL" means one of these.',
    '',
    ...skills.map(({ name, description }) => `- **${name}** — ${description}`),
  ].join('\n');
}

/** Whether telling this stage about scratch space would mean anything to it. */
function canWrite(agent: AgentDef): boolean {
  return agent.allowedTools.some((t) => t === 'Write' || t === 'Edit' || t === 'Bash');
}

/**
 * The scale, stated as a bare fact. What it *means* is each agent's own business:
 * review scales how much of the surrounding code it surveys, verify scales how hard
 * it probes, and the sizes do not correspond. One paragraph handed to all three said
 * something slightly wrong to each, so the guidance now lives in `agents/*.md` where
 * a specialist can say it in its own terms — and where a human edits prose as prose.
 *
 * The plan is not told: it is the stage that decides this, and would be reading its
 * own last answer back as though it were an instruction.
 */
function declaredScale({ agent, scale }: BriefInput): string | undefined {
  if (agent.stage === 'plan' || scale === undefined) return undefined;
  return `The plan judged this **${scale}**.`;
}

/**
 * What review or verify asked to be put right. Only the stage that has to put it
 * right is told: a reviewer handed the last round's objections would be reading
 * its own words back as though they were instructions, and the diff in front of it
 * is the only honest account of whether they were addressed.
 */
function changesFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage !== 'implement' || ticket.changes === null) return undefined;

  return [
    'The approach is right; these are wrong. Address each one, and change nothing',
    'else — this is a revision of work that has already been reviewed, not a',
    'rewrite of it.',
    '',
    ticket.changes,
  ].join('\n');
}

/**
 * The finish line, as the plan set it and the manager agreed it. Not shown to the
 * plan, which is writing it. Shown to everyone else because it is the difference
 * between "is this done" — a question with an answer — and "is this as good as it
 * could be", which has none, and which is what ended the first two real tickets.
 */
function completionCriteriaFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage === 'plan' || ticket.completionCriteria.length === 0) return undefined;

  const asked =
    agent.stage === 'implement'
      ? 'Build the smallest thing that makes all of these true. Nothing beyond them.'
      : 'These, and defects. Anything else you would like is a later ticket, not a verdict.';

  return [...ticket.completionCriteria.map((d) => `- ${d}`), '', asked].join('\n');
}

/**
 * The approved plan. The plan stage is writing one, so it is never shown an approved
 * plan — only, in `rejectedPlanFor`, the one it has to replace.
 */
function planFor(agent: AgentDef, ticket: Ticket): string | undefined {
  return agent.stage === 'plan' ? undefined : nested(ticket.plan ?? undefined);
}

/**
 * The plan the objection above is about, shown to the plan stage alone and only while
 * an objection is standing.
 *
 * Rejecting a plan is the manager's main hold over the loop, and it was the part the
 * workbench handled worst: the next plan was given the objection and not the plan it
 * was against. t48's second plan was asked "why does it say no design requirement?"
 * without sight of the sentence that said it, and re-read seven files working out what
 * it had written.
 *
 * A fresh run rather than a resumed conversation, and said to be disposable. What comes
 * back is usually an objection to the approach, and a plan defended instead of rewritten
 * is how two tickets died.
 */
function rejectedPlanFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage !== 'plan' || ticket.rejection === null || ticket.plan === null) {
    return undefined;
  }

  return [
    'What was objected to. It is here so you can see what they meant, not so you can',
    'defend it — keep none of it if none of it is right.',
    '',
    nested(ticket.plan) ?? '',
  ].join('\n');
}

/**
 * Markdown the brief is quoting rather than saying — the project's file, a plan —
 * comes with its own headings. Left as they are, they sit at the same level as this
 * brief's sections, so the project's "How to work here" reads as an instruction the
 * workbench is giving, and a plan's own headings read as more of them. Demoted two
 * levels, they nest under the heading that introduces them and it stays obvious
 * which is which.
 *
 * Headings inside code fences are left alone: there, `#` is a shell comment.
 */
function nested(markdown: string | undefined): string | undefined {
  const text = markdown?.trim();
  if (text === undefined || text === '') return undefined;

  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      return inFence ? line : line.replace(/^(#{1,4}) /, '##$1 ');
    })
    .join('\n');
}

function fenced(text: string | undefined, lang: string): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  return `\`\`\`${lang}\n${text.trim()}\n\`\`\``;
}

/**
 * What the workbench already ran, and what it said. Verify is told this so it does
 * not spend turns re-running commands whose result is already a matter of record —
 * and so it knows what *was* covered, which is what tells it what was not.
 */
function checksRun(checks: readonly CheckRun[] | undefined): string | undefined {
  if (checks === undefined || checks.length === 0) return undefined;

  const lines = [
    'These were run for you, in this worktree, before you started. You do not need',
    'to run them again, and re-running them to confirm is a wasted turn.',
    '',
  ];

  for (const { command, ok, output } of checks) {
    lines.push(`**\`${command}\`** — ${ok ? 'passed' : 'FAILED'}`);
    if (output.trim() !== '') lines.push('', '```', output.trim(), '```');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
