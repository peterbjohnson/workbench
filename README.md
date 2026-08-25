# Workbench

A board of tickets. Each ticket is a piece of work you want done. Agents do the work; you
decide what gets done and whether it is good enough.

Every ticket goes through four stages — **plan**, **implement**, **review**, **verify** —
each one a separate agent with its own tools. You approve the plan before any code is
written, and accept or reject the result as a pull request.

**The plan says when the ticket is finished.** It ends with a `DONE WHEN:` list — a few
conditions anyone could check — and you agree them by approving the plan. That list is then
the *only* thing review and verify are entitled to object about. Without it they are
answering "is this as good as it could be", which has no end: it is what killed both of the
first real tickets, each reviewed against an idea of perfection nothing could satisfy.

**Anything an agent thinks would merely be better goes under `LATER:`**, not in the verdict.
Those appear on the ticket with two buttons — **Backlog** and **Commit to it** — so a good
idea costs one click to keep and nothing to ignore.

**You can always ship.** Any ticket with commits has a **Ship it** button that offers what it
has as a pull request, whatever the agents made of it. It is not a bypass — the pull request
is still a review and merging is still deliberate — but it means two agents disagreeing can
no longer be the end of a ticket. When the cycle limit is reached the ticket now stops and
asks you to settle it rather than being given up on.

**Review and verify say which kind of "no" they mean.** Specific things wrong with sound
work go back to **implement** as changes to make, carrying the objections and keeping the
draft. Only an approach that cannot be fixed by editing what is there is a rejection, and
only a rejection buys a new plan. Two tickets died before this existed, having between them
raised six objections — every one of them a wrong number or an unsupported claim, and every
one of them paid for with a whole new cycle.

Two rounds of changes are allowed against one plan. An objection that survives being
addressed twice is evidence about the approach, so the third becomes a rejection.

## What you need

- **Node 26+** — the workbench uses Node's built-in SQLite and its TypeScript support, so
  there is no database to install and nothing to build but the board.
- **yarn**
- **git**, and **`gh`** authenticated, for pull requests.

```bash
yarn install
claude setup-token     # a long-lived token from your Claude subscription
yarn wb auth           # spends a fraction of a penny proving the token really works
```

`claude auth login` also works but expires, and renewing it needs a browser — which a
container cannot do. `export ANTHROPIC_API_KEY=...` uses a Console key, billed per token.

⚠️ **`ANTHROPIC_API_KEY` wins over everything else.** A forgotten one in a shell profile is
how a workbench ends up quietly working as an account you did not intend. `wb auth` and
`wb serve` both name the credential in use, so check what they say rather than what you
remember setting.

**Being logged out is not a broken workbench.** Everything you do yourself needs no
credential — only the agents do. So `wb serve` starts either way: tickets queue, nothing
is spent, and they start on their own once you are set up again.

## Running it

Start the workbench first — one process holding the API, the board and the orchestrator:

```bash
yarn serve          # http://127.0.0.1:4600
```

That builds the board and then starts everything. The build takes a moment and means the
board you are looking at is the board in the repository — there is no step to remember
after pulling, and no way to spend an afternoon puzzled by a change that is on disk and
not on screen.

⚠️ **This calls real agents and spends real money.** Every other command only talks to it
over HTTP. To try it without spending anything, `WB_RUNNER=fake yarn serve` runs a scripted
agent that makes no external calls but does real work on disk, so worktrees, commits and
diffs are genuine.

It prints what the agents do as they do it. Ctrl-C finishes what is in flight before
exiting, and restarting picks up where it left off: every ticket is rebuilt from its
event history.

Then, from anywhere:

```bash
yarn wb new "Add a retry" "It gives up on the first failure."
yarn wb new --from t13 "Fix the units"  # carry on from a ticket's work
yarn wb new --after t40,t41 "Couple it"  # hold it until those have offered their work
yarn wb edit t1 "Add a retry"      # rewrite it; leaves the instructions alone
yarn wb queue t1                   # commit to it; nothing starts before this
yarn wb backlog t1                 # take it back, if it has not started
yarn wb move t3 t1                 # put t3 in front of t1; no second id means last
yarn wb wait t3 t1,t2              # hold t3 until t1 and t2 offer their work; "none" lets go
yarn wb list                       # every ticket and where it is
yarn wb show t1                    # one ticket, its plan, and everything that happened
yarn wb approve t1                 # let implementation start
yarn wb reject t1 "wrong problem"  # send it back to be planned again
yarn wb changes t1 "the units"     # keep the work and put these right
yarn wb answer t1 "use etc/"       # unblock a ticket that asked you something
yarn wb restart t1                 # run a failed stage again, from the top
yarn wb ship t1                    # offer what it has as a pull request, and decide there
yarn wb cancel t1 "not now"        # stop it, even mid-run
yarn wb wip 2                      # how many tickets may run at once
```

A ticket stops and waits for you at three points: the **backlog**, the **plan gate**, and
any time an agent hits something it cannot decide. It will not guess.

**The plan gate can be turned off, per ticket, when you write it** — the switch on the new
ticket form, or `wb new --no-approval`. It defaults to on: the gate is the one place a
person sees the work before any money goes on building it, so skipping it is something to
choose rather than something to forget. Off, the ticket goes straight from planning to
implementing. Nothing else changes: the plan is still written, still recorded, and still
the `DONE WHEN:` list that review and verify hold the work to. The ticket says so on its
panel and in `wb show`, because a ticket that never stopped for you otherwise looks like
one whose gate you missed.

You accept finished work by **merging** its pull request, and reject it by **requesting
changes** — your review comment becomes the reason the next plan gets.

**You get the same two "no"s the agents do, from the panel, at any point.** Review and
verify each choose between them, and so do you:

- **Send it back** — the approach is wrong, so it buys a whole new plan. What you write
  is what the next plan is written against.
- **Ask for changes** — the approach is right and some details are not. Straight back to
  implement, keeping the work. Much the cheaper of the two.

Neither is rationed. `maxCycles` and `MAX_REVISIONS` exist because two agents repeating an
objection is evidence about the approach; a manager repeating one is just the manager, and
cutting you off after twice would be the workbench overruling the person it works for.

**A ticket keeps its pull request through all of this.** The branch keeps it, the rework is
pushed to that same one, and the link stays on the panel — which is where the objection
being answered was written, so it is worth most exactly while the work is being put right.
What ends is the *offer*, which is what lets you ship the ticket or restart a failed stage
while it is in hand.

## The board

`http://127.0.0.1:4600` — four pages, named across the top. **Board** is the work;
**Agents**, **Skills** and **Settings** are the workbench itself, and each is in the
address (`#agents`), so one can be linked to and survives a reload.

Tickets in columns, moving themselves as the work proceeds:

| | |
|---|---|
| **Backlog** | ideas. **The workbench never touches this column.** |
| **Committed** | you have decided to do it. Work starts from the top. |
| **Planning** | a plan is being written |
| **Approval** | it is waiting for you to approve that plan |
| **Building** | implement, review, verify |
| **Pull request** | offered, and waiting on a merge or a change request |
| **Done** | finished, cancelled or given up on |

The only card you move *between columns* by hand is one between **Backlog** and
**Committed** — drag it, or use the button on the card. Everything to the right of that
moves itself, and a ticket that is stuck stays in the column of the stage it stopped in,
marked as needing you. The header counts everything waiting on you.

**Order is the queue, so it is yours to set.** Work is taken from the top, and dragging a
card onto another puts it in front of that one; onto the column behind them, last. That
holds in every column — the order a ticket was written in is a default, not a decision.

**A ticket can be held until others are finished with**: `wb wait t43 t37,t40`, `wb new
--after`, or the **Start after** box — on the panel and on the new-ticket form, which is
usually the moment you know what the work follows. You filter it by typing and pick from it — an id is not
something anyone remembers, and a free-text box takes an id that does not exist as readily
as one that does. Only tickets that would actually hold it back are offered. It runs
nothing at all until every one of them has let go, says whose cards it is behind, and does
not say `queued` — a slot coming free would do nothing for it.

The release is the **pull request, not the merge**. What one ticket needs of another is
that it stop committing; after that its branch is final, and a ticket that needs the code
itself starts *from* that branch (`wb new --from`) rather than from a merge that has not
happened. Waiting for the merge would put every dependency behind a person. A ticket that
was cancelled or given up on releases what waits on it too: nothing else ever would, and a
queue held up by a ticket nobody is working on is the one failure with no way out.

**New ticket**, at the top of the backlog — which is the column the ticket appears in —
opens a blank one: a title, the instructions the work is done from, which is what every
stage is briefed with in full, and what it starts after. The address carries the ticket
(`#t7`), so a card can be linked to. It updates live off the event stream; there is no
polling and no refresh button.

**A ticket opens on where it has got to.** Everything that identifies it is in one line
under the title — what it costs, which round it is on, who it waits for, its pull request —
then a line of stages saying which ran and how each ended, then whatever it is waiting on
you for, then the buttons that answer it, **Ship it** among them.

**Everything you can do to a ticket is in that one block**, including **Cancel**. Anything
needing something typed or picked is one grid — what it is, what you say, the button — so
the buttons are the same width and in the same place rather than reading as a row of
differently-sized decisions:

| | |
|---|---|
| **Answer it** | when a stage stopped to ask you something |
| **Start after** | which tickets this one waits for |
| **Ask for changes** | keep the work, put these right |
| **Replan it** | the approach is wrong; buy a new plan |
| **Reject/cancel it** | stop it |

Anything that has not ended can be cancelled, an idea still in the backlog included — that
is how one you have decided against leaves the board.

Under those, in the order you read them: the **description**, then the plan, then what each
stage made of it. The description comes first because the plan and the runs are answers to
it, and judging work against anything else is how a ticket gets rejected for something it
never asked for. It stays folded — it is the longest thing on the panel — and opens by
default on a ticket that has not started, which is nothing else yet.

**Nothing is shown at full length twice.** The plan collapses to its steps, each stage run
collapses to a line — what it was, what happened to it, its checks, its tool calls and what
it cost — and the prose opens when you want it.

**Everything that happened** is the whole record, one line per event, and any line with
more behind it opens: what an agent said in full, the arguments a tool was really given,
what a stage cost. Most of what an agent does is in there and none of it fits on a line.

**A stage that failed can be restarted.** A crash — the model service hanging up, a push
that could not reach the remote — parks the ticket with nothing to answer, so the panel
offers **Restart this stage** rather than a question box. It runs again from the top, and
the failed attempt stays in the record beside the one that worked.

## Not going stale

A branch is cut from `origin/main` once, and then the ticket works for hours while other
tickets merge. By the time it is offered it is built on a base that no longer exists, and
that — not any difficulty about merging text — is where conflicts come from.

So the base is brought in rather than resolved later. Before a ticket opens its pull
request, and again for every pull request still standing when another one merges, the
branch merges the current base and the standing checks are run against it. A branch that
already has the base is the ordinary case: nothing merges, nothing is recorded, nothing is
re-run and nothing is spent.

When something does merge and the checks then fail, or the merge conflicts outright, the
ticket **blocks** with the failing output or the conflicting paths. Its work stands and its
branch is untouched; what to do about it — ship it, put it right, stop it — is a decision
rather than another stage. Nothing is offered against a base it cannot sit on.

A pull request you have already answered is left alone. Pushing a merge to it would be a
commit made for reasons nothing to do with your objection, and a branch that has moved past
a change request reads as one that has addressed it.

## Work that outlives its ticket

Work only leaves the workbench by being accepted. A ticket that is cancelled, or given up
on, still has its commits on `wb/<id>` — and nothing could reach them: a worktree is cut
from `origin/main`, and the guard refuses every path outside it.

```bash
yarn wb new --from t13 "Fix the units" "The headline claim is not supported by table 2."
```

The new ticket's branch is cut from that ticket's, so the earlier work is **in its own
worktree** from the first stage: readable, editable, and needing no exception to the guard.
Its brief says what it is carrying on from and why that stopped — which is worth more than
the code, because an objection nobody passes on is rediscovered at full price. It is also
the only way: the objections are events in a database the worktrees deliberately cannot
see, so an agent that is not told cannot find out, however hard it looks.

It is not restricted to tickets that failed. The rule is *start from that ticket's branch
instead of main*, and it reads the same whether the work was abandoned, superseded, or
finished and now being extended.

A stopped ticket that left commits says so on its card, in Done, and opening it offers
**Carry on from this** — which writes the new ticket already pointed at that branch. That
is the only moment it can be said: a ticket's branch is cut when it is created, so a body
that merely *mentions* an earlier ticket starts from main like any other, and the work it
meant to salvage is not there.

Every objection the earlier ticket drew is passed on, not only the last. One that survived
being answered twice is rejected for the same thing three times, and that it recurred is
the most useful thing about it.

## Steps, and knowing where a run has got to

The plan ends with a `STEPS:` list, the way it ends with `SCALE:`. They cost nothing extra
— the plan is writing them anyway — and you see them when you approve, so approving the
plan approves its steps.

Afterwards they are what progress is reported against. The implement stage says `STEP <n>`
as it begins each one; the workbench turns that into a `step_reached` event, and the card
says `step 2/5` instead of `running` while the stage works. Without it a twenty-minute
stage says nothing but that it is going, with a hundred tool calls scrolling past.

An agent that never announces a step costs the ticket its checklist and nothing else.

**A ticket can be rewritten at any point**, including while it is being worked on. Every
stage is briefed from the ticket as it stands when that stage starts, so a rewrite reaches
everything that has not begun; a stage already running keeps the wording it was given,
because it has already read it.

React and Vite, in `ui/`. `yarn serve` builds it and serves it; `yarn ui` runs it
on port 5173 with reloading, talking to a workbench you started separately.

## The API

`wb serve` is the only process that touches the database or runs agents. The command line
is a client of it, and the board is another — so nothing is reachable from one and not the
other.

| | |
|---|---|
| `GET /tickets` | every ticket |
| `POST /tickets` | create one — `{title, body, from?, requiresApproval?, waitsFor?}`; `from` starts it on that ticket's branch, `requiresApproval: false` skips the plan gate, and `waitsFor` holds it until those tickets have offered their work |
| `GET /tickets/:id` | one ticket and everything that happened to it |
| `POST /tickets/:id/edit` | rewrite it — `{title?, body?}`, and what is absent is left alone |
| `POST /tickets/:id/queue` | commit to it — the workbench may now start it |
| `POST /tickets/:id/backlog` | take it back out of the queue |
| `POST /tickets/:id/move` | put it in front of another — `{before}`; null for last |
| `POST /tickets/:id/wait` | hold it until these offer their work — `{tickets}`; the whole set each time, empty lets it go |
| `POST /tickets/:id/approve` | approve a plan |
| `POST /tickets/:id/reject` | send it back to be planned again — `{reason}` |
| `POST /tickets/:id/changes` | keep the work and put these right — `{changes}` |
| `POST /tickets/:id/answer` | answer a blocked ticket — `{answer}` |
| `POST /tickets/:id/restart` | run a failed stage again, from the top |
| `POST /tickets/:id/ship` | offer what it has as a pull request, whatever the agents said |
| `POST /tickets/:id/cancel` | stop a ticket — `{reason}` |
| `GET /policy`, `PUT /policy` | the limits — `PUT` takes any of them, and leaves the rest |
| `GET /settings`, `PUT /settings` | everything the workbench is set to — `PUT` takes any of them |
| `GET /agents`, `GET /skills` | each file, with its text and what it declares |
| `PUT /agents/:stage`, `PUT /skills/:name` | save one — `{text}`; refused if it would not load |
| `GET /events` | server-sent events, live |

Nothing here decides anything: each endpoint appends one event and lets the rules react.

## Configuration

**Settings** on the board is all of it in one page — the limits, how the work is done,
and where things are — each with what it does and whether changing it waits for a
restart. The limits are in the database and take effect at once; everything else is the
config file below, so it takes effect when the workbench is next started.

Defaults live in `src/config.ts`. Override any of them in `workbench.config.json`, or
from that page:

```json
{
  "base": "main",
  "checks": ["PYTHONDONTWRITEBYTECODE=1 python3 -m compileall -q ."],
  "about": "claude.md",
  "worktreeRoot": ".worktrees"
}
```

`checks` are the standing suite. **The workbench runs them itself**, in the ticket's
worktree, at the start of the verify stage — not the verify agent. That matters: a pass
is then something observed and written into the ticket's record, rather than something an
agent reports. If any check fails the ticket goes straight back to planning with the
failure output as the reason, and **no agent is called at all**, so discovering a broken
test is the cheapest thing the workbench does rather than the most expensive.

With none set, verify's `APPROVED` only ever means "I could not break it" — so `wb serve`
says so loudly at startup. A check must write nothing: it runs inside the worktree it is
judging, and anything it leaves behind lands in the pull request.

`about` is a file describing the project, put in front of every stage. Facts that do not
change between tickets — what this repository is, where things live — cost an agent
several tool calls every time it rediscovers them. Keep it short: every stage of every
ticket reads it. Point it at nothing and the section is simply left out.

Each ticket gets its own git branch (`wb/<id>`) and its own worktree, so tickets running
at the same time cannot collide and your own working tree is never touched. It also gets
a **scratch directory** beside the worktree, for probes and working-out: it is writable,
it is never committed, and an agent is told not to bother tidying it up. A ticket that is
accepted has both removed; the branch stays, because the pull request is on it.

## Limits

A ticket cannot run away with your money:

| | |
|---|---|
| `wipLimit` (2) | how many tickets may have a stage running at once |
| `maxCycles` (3) | how many times one ticket may be planned before the workbench stops |
| `maxTicketUsd` (50) | what one ticket may cost, across every stage and every cycle |

Every run's cost is recorded on the ticket, so `wb show` says what it has spent. A ticket
that hits a limit is **given up on** — a different thing from blocked, which means stuck
and answerable.

**A ticket the limit is holding back says `queued` on its card.** Approving several plans
at once puts them all in Building, where only `wipLimit` of them run; the rest used to sit
there marked with nothing at all, which reads as a card nothing is going to happen to.

**A scale is not advice.** Each one sets the turns, the budget and the effort every stage
after the plan runs under: a `small` ticket gives implement 60 turns and $5 where a standard
one gets 200 and $20, and review 25 turns and $3. Reviewing t13 — a ticket its own plan
called small — cost more than building it, on all three of its cycles.

Separately, the plan says how much the work warrants — `small`, `standard` or `large` —
and `wb show` prints it beside the plan, so approving the plan approves its own
self-assessment. **No stage is ever skipped.** A `small` ticket is still implemented,
still reviewed adversarially and still verified; each is simply asked for a proportionate
look rather than the maximum one. A plan that says nothing gets `standard`, so forgetting
is never the cheap way to a lighter review.

## Skills

`skills/<name>/SKILL.md` is written expertise: how a report is structured here, how Python
is written here. Every stage gets every one of them, named in its brief with its
description, and reads one with the `Skill` tool. **Skills** on the board reads and writes
them, as does **Agents** for `agents/<stage>.md`. They load as a local plugin from
`workbench/`, so an agent gets the workbench's expertise and never the project's own
configuration — and the guard refuses any skill that is not the workbench's, whatever else
the machine has installed.

**Nothing is rationed per stage.** Review has to judge a report against the standard
implement wrote it to, so giving them different expertise would be arranging a
disagreement. The `description` is the whole trigger — it is what an agent reads to decide
whether a skill is worth opening — so it says what the skill is *and when to use it*.

Before this, a stage could be handed a skill and refused the tool to read it, and no brief
mentioned that skills existed at all. t16 was asked to follow the report skill, went
looking for it as a file, was refused every path it tried, and stopped to ask the manager —
holding it the whole time.

## Tools

A turn costs its whole context whatever it carries — a median 48k tokens to get back a few
hundred characters — so the tools exist to answer a question in one turn rather than point
at a file that takes another two to read. `scripts/toolmix.mjs` prints what the stages
actually did, from the event log and the SDK transcripts; run it before and after changing
any of this.

**Every stage's brief lists every file in the worktree**, with its line count and what is
defined in it, worked out from the source just before the run starts. That costs no turn at
all, which is why `Glob` is gone: plan spent a quarter of its calls on it and review an
eighth, all of them learning a shape that is the same every ticket. It is named in
`disallowedTools`, not merely left out of `allowedTools` — leaving it out only stops a tool
being auto-approved, and the agent is still offered it, still calls it, and still loses the
turn to a refusal.

Two tools go further, and both are read-only:

- **`mcp__wb__map`** — what is defined in a file or directory, with the lines each thing
  spans, so a `Read` can be aimed instead of pulling the whole file. Markdown gets its
  headings, tables and figures.
- **`mcp__wb__where`** — every use of a name, grouped into definition, import, call with
  its argument count, attribute and assignment. A caller the diff forgot shows up as a call
  whose argument count no longer matches the definition.

`Read` and `Grep` stay. A tool with a built-in rival earns the schema cost of both and the
usage of one, so the only tools added are ones nothing built-in already does. Both are
honest about their limits in their own descriptions: Python and JavaScript are parsed but
not resolved, so two functions sharing a name are both reported, and prose is not searched
at all — a word in a report is not a reference, and saying it was would be a worse `Grep`
wearing the authority of a parser.

They are registered per run, from that stage's own grant, because `allowedTools`
auto-approves rather than restricts and tickets run concurrently in their own worktrees.
The handlers call the same `guard` the hook does rather than trusting it, so confinement
holds whether or not `PreToolUse` fires for an MCP call.

`src/code/` is where the parsing lives: Python from Python's own `ast` over one `python3`
process for the whole batch, JavaScript from `ts.createSourceFile`, Markdown from a scan.
Nothing new is installed to do any of it.

## Protecting the workbench from the agents

The workbench and the project live in one repository, so a ticket's worktree would
normally contain `workbench/` — and an agent could edit the guardrails it runs under.
`protectedPaths` (default `["workbench"]`) stops that in three ways:

1. **The files are not there.** Protected directories are excluded from every ticket
   worktree by sparse checkout. They stay in the branch and in anything committed from it;
   they are simply absent from disk, so no tool can reach them.
2. **The guard refuses writes** to protected paths, and records every attempt.
3. **Git commands that could undo this** — `sparse-checkout`, `config`, `checkout`,
   `switch`, `reset`, `rebase` — are refused.

⚠️ **This is a strong speed bump, not a wall.** An agent with `Bash` can still name an
absolute path outside its worktree, and nothing here inspects `cd`. Closing that properly
needs operating-system isolation: run agents in a container, or as a user with no write
access to `workbench/`. Until then, treat the implement stage as trusted-but-recorded.

## Working on the workbench itself

```bash
yarn test
yarn typecheck
```

The tests need no API key, no network and no agents: the rules, the state machine, the
guard and the orchestrator are all tested with the outside world faked, and the git tests
run against throwaway repositories.

**The board has no test framework of its own.** Anything about the board worth testing —
which statuses make which column, how a history folds into one block per stage — is plain
TypeScript in `src/domain/board.ts`, covered by the same `node:test` as everything else.
What is left in `ui/` is markup, and you check that by looking at it — with one
exception, `Markdown.tsx`, which is real parsing and is checked the same way. It renders
to React elements rather than to HTML, so nothing it produces can put a script on the
board however a document is written; what it does not recognise it leaves as the text it
was, and Edit shows the file exactly as written either way.

## Layout

```
agents/           one markdown file per stage: its job, its model, the tools it may use
                  — read and written from the board, and read again per run
skills/           written expertise, loaded into an agent when it works
ui/               the board: React, built by Vite into ui/dist
src/workbench.ts  the composition root — how all of the below is wired together
src/domain/       what a ticket is, the rules for what may happen to it, and the columns
src/store/        the event log, in SQLite
src/agents/       loading agent definitions, and assembling what an agent is told
src/run/          the guard, the model-service adapter, and a fake agent for testing
src/git/          a branch and worktree per ticket
src/github/       pull requests and verdicts
src/orchestrator/ the loop that drives tickets through stages
src/api/          the HTTP server, the board it serves, and the client the CLI uses
src/cli/          this command line
```

## Also here

- [`workbench_spec.md`](workbench_spec.md) — what the workbench must do, and why
- [`NOTES.md`](NOTES.md) — decisions taken, and the questions still open
