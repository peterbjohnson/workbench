# Design

Why the workbench is shaped the way it is. What it does is in
[Using it](using-it.md); what to type is in the [Reference](reference.md).

## The user is the product manager. The agents are the engineers.

You decide what gets done and whether it is good enough. Agents do the work. Nothing
about that is negotiable by an agent: it cannot decide a ticket is finished, cannot
decide one is not worth doing, and cannot enlarge what it was asked for.

## The workbench holds none of the project's material

The split is between **the work** and **how the work is done** — not between generic
machinery and domain knowledge.

The workbench carries no models, no code under study, no data, no results. Those are the
subject of the work and they live in the project. What lives in `.workbench/` is how work
is directed here: the branch to work from, the checks every ticket must pass, and the
skills saying what good looks like for work of a kind.

Skills in particular are the project's, not the tool's. How a repository writes Python or
structures a report is not something a tool can arrive knowing.

## The plan says when the ticket is finished

A plan ends with a `DONE WHEN:` list — a few conditions anyone could check — and you agree
them by approving the plan. That list is then the **only** thing review and verify are
entitled to object about.

Without it they are answering "is this as good as it could be", which has no end. A
question with no answer cannot be the gate on shipping.

## Anything merely better is a later ticket

An agent that can see an improvement beyond `DONE WHEN` puts it under `LATER:`, not in its
verdict. Those appear on the ticket with two buttons — **Backlog** and **Commit to it** —
so a good idea costs one click to keep and nothing to ignore.

This is not a way of silencing agents. It is a way of separating *this work is wrong* from
*something else would also be good*, which are different claims that were arriving in the
same sentence and being paid for at the same price.

## Two kinds of "no"

Review and verify each say which they mean, and so do you:

- **Ask for changes** — the approach is right and some details are not. Straight back to
  implement, carrying the objections and keeping the draft. Much the cheaper of the two.
- **Send it back** — the approach cannot be fixed by editing what is there. Only this buys
  a whole new plan.

Two rounds of changes are allowed against one plan. An objection that survives being
addressed twice is evidence about the approach, so the third becomes a rejection.

Those caps apply to agents, not to you. Two agents repeating an objection is evidence; a
manager repeating one is just the manager, and cutting you off would be the workbench
overruling the person it works for.

## You can always ship

Any ticket with commits can be offered as a pull request, whatever the agents made of it.

It is not a bypass — the pull request is still a review and merging is still deliberate —
but it means two agents disagreeing can no longer be the end of a ticket. When a limit is
reached the ticket stops and asks you to settle it rather than being given up on.

## Nothing decides anything but the rules

`wb serve` is the only process that touches the database or calls an agent. The command
line is a client of it and the board is another, so nothing is reachable from one and not
the other.

Every endpoint appends one event and lets the rules react. A ticket is not a row that gets
updated; it is rebuilt from its own history every time it is read. That is why stopping the
workbench mid-flight loses nothing, and why the record of what happened cannot disagree
with the state it produced.

## The agents cannot reach the workbench

An agent that can edit the guardrails it runs under is not running under guardrails.

The workbench is installed rather than checked in, so it is in `node_modules` and a ticket
worktree — a git checkout — does not contain it at all. What is still in the repository and
must be protected is named in `protectedPaths`: it is excluded from every worktree by
sparse checkout, the guard refuses writes to it, and the git commands that could undo
either are refused.

⚠️ **This is a strong speed bump, not a wall.** An agent with `Bash` can still name an
absolute path outside its worktree. Closing that properly needs operating-system
isolation — a container, or a user with no write access. Until then, treat the implement
stage as trusted-but-recorded.

## A turn costs its whole context

Not the bytes it returns. A stage spending a turn to learn something costs the entire
conversation so far, which is why the tools are shaped to answer a question in one turn
rather than point at a file that takes another two to read — and why every brief already
lists every file in the worktree, worked out from the source before the run starts.

`scripts/toolmix.mjs` prints what the stages actually did, from the event log and the SDK
transcripts. Run it before and after changing any of this.
