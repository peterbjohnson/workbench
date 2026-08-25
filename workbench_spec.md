# Workbench Spec

What the workbench is and what it must do. Not a design, not a plan — those come
next, and this document is what they are judged against.

## Purpose

An AI workbench: a board where the user directs work, and agents carry it out
against a codebase under strong guardrails.

**The user is the product manager. The agents are the engineers.**

## Separation

The workbench and the project it operates on are separate things. The split is between
**the work** and **how the work is done** — not between generic machinery and domain
knowledge.

- The workbench lives in `workbench/` at the repository root.
- **The workbench is built for this problem and is not generic.** Its skills carry real
  domain expertise: how to judge a result, what a review must check, what makes a test
  meaningful here. That expertise is knowledge about how work is directed, and it
  belongs in the workbench.
- **`workbench/` holds none of the project's own material** — no models, no code under
  study, no data, no results, no reports. Those are the subject of the work.
- The project holds the work, and carries nothing that exists for the workbench's
  benefit.

## Layers

1. **UI** — a Trello-like kanban board. TypeScript, React, a current well-supported
   framework.
2. **Orchestrator** — the backend. Holds the logic rules, exposes endpoints, and
   orchestrates agents and tools. The UI is one caller; a CLI or other source of
   commands is another. All callers go through the same endpoints.
3. **Resources** — agents, skills, tools.

**Agents run on the Claude SDK, behind an abstraction layer**, so the runtime can be
changed later. The layer wraps the runtime's job — run an agent, stream its events,
return a result. It does not re-specify what an agent is.

## The unit of work

**A card is a ticket: one unit of work the user wants done.** A ticket owns a
sub-process of four stages, each a separate agent call:

| Stage | What it does |
|---|---|
| **Plan** | Produces a plan. **Takes no actions and writes no code.** |
| **Implement** | Writes all code, including the ticket's tests. |
| **Adversarial review** | **Reads.** A fresh agent argues against the plan and the diff — wrong problem, missed cases, hidden assumptions. |
| **Verify** | **Runs.** Executes the tests, and attempts to break what was built. |

**The stages are a loop, not a pipeline.** Any rejection returns the ticket to plan,
and then implement — whether adversarial review does not approve, verify fails, or the
user rejects at the pull request. One rule, no exceptions: nothing is patched without a
re-planned approach, and the plan gate applies again. A ticket may go round more than
once.

**A return trip is proportionate.** The change planned may be very light, the
implementation very small, and the review and tests very quick. What it may never be
is unplanned — skipping the plan is where the problems come from, not the size of the
change.

## Control

- **The plan stage is gated.** The user approves the plan before implementation
  starts. Nothing is built against an unapproved plan.
- **After the gate, stages may pause for manager input.**
- **Never assume — ask.** When an agent cannot decide something, the card moves to
  **Blocked**: the agent writes its reasoning and why input was needed onto the card,
  and it shows on the board as needing the user. Work resumes with the answer in
  context.

The user's touchpoints per ticket: write it, gate the plan, accept or reject the
result — plus answering any card that blocks.

## Working on the code

- **A git worktree and branch per ticket.** Agents never touch the user's working
  tree, and concurrent tickets cannot collide.
- **A ticket ends by opening a pull request.** The PR is where the user accepts or
  rejects. (Requires the repository's existing remote to be linked.)

## Concurrency

**Parallel.** Multiple tickets run at once, with a work-in-progress limit enforced by
the orchestrator, set to **2** to start and raised with confidence.

**Which of them goes first is the user's.** Work is taken from the top of the board, and
the board's order can be set — the order tickets were written is a default, not a decision.

**A ticket can be held behind another**, and runs nothing until that one offers its work
as a pull request or ends. The pull request rather than the merge: what one ticket needs
of another is that it stop committing, and one that needs the code itself branches from it.

## Testing

Testing is the load-bearing guardrail — agents left unchecked go wild. It has three
parts:

1. **Standing test suites**, run against every ticket.
2. **Ad-hoc tests written per ticket by the implement agent**, which join the
   standing suites on acceptance.
3. **Adversarial QA** — the verify agent attempts to break and penetrate what was
   built, beyond the written tests.

**Cost constraint.** Testing must not raise token usage or development time by an
order of magnitude. This is a property the design has to achieve, not a limit imposed
on top of it. Some tickets warrant more testing than others; explicit limits may
prove necessary, and the design is expected to be learned and adapted rather than
fixed now.

## Scope of the first build

The minimum is a ticket that moves **in progress → ready for review**, with the four
stages and the gate working.

Nice to have, not required first pass:

- live agent output streaming onto the card
- CLI parity with the UI
- cost and token accounting
- managing agents, skills and tools from the UI

## Standing rules

- **Never assume; always ask.** Intent is stated explicitly by the user, never
  inferred. This applies to the agents the workbench runs, and to the building of the
  workbench itself.
- **The workbench is not the project.** The project is not being built, planned or
  designed yet.

## Settled elsewhere

Left open deliberately, for the planning stage: the specific framework and
persistence, endpoint shapes, how the abstraction layer is drawn, what the standing
suites contain, and whether budget limits become explicit.
