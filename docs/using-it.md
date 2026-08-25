# Using it

The board, the ticket panel, and how work moves. Why it works this way is in
[Design](design.md); what to type is in the [Reference](reference.md).

## The board

`http://127.0.0.1:4600` — four pages, named across the top. **Board** is the work;
**Agents**, **Skills** and **Settings** are the workbench itself. Each is in the address
(`#agents`), so one can be linked to and survives a reload.

Tickets sit in columns and move themselves as the work proceeds:

| | |
|---|---|
| **Backlog** | ideas. **The workbench never touches this column.** |
| **Committed** | you have decided to do it. Work starts from the top. |
| **Planning** | a plan is being written |
| **Approval** | it is waiting for you to approve that plan |
| **Building** | implement, review, verify |
| **Pull request** | offered, and waiting on a merge or a change request |
| **Done** | finished, cancelled or given up on |

The only card you move between columns by hand is one between **Backlog** and
**Committed**. Everything to the right of that moves itself, and a ticket that is stuck
stays in the column of the stage it stopped in, marked as needing you. The header counts
everything waiting on you.

**Order is the queue, so it is yours to set.** Work is taken from the top; dragging a card
onto another puts it in front of that one, and onto the column behind them puts it last.
The order a ticket was written in is a default, not a decision.

## The plan gate

A plan is written, and the ticket stops for you to approve it. That is the one place a
person sees the work before any money goes on building it.

**The gate can be turned off per ticket, when you write it** — the switch on the new ticket
form, or `wb new --no-approval`. It defaults to on, so skipping it is something to choose
rather than something to forget. Off, the ticket goes straight from planning to
implementing; the plan is still written, still recorded, and still the `DONE WHEN:` list
that review and verify hold the work to. The ticket says so on its panel, because one that
never stopped for you otherwise looks like one whose gate you missed.

## The ticket panel

**A ticket opens on where it has got to.** Everything identifying it is in one line under
the title — what it costs, which round it is on, who it waits for, its pull request — then
a line of stages saying which ran and how each ended, then whatever it is waiting on you
for, then the buttons that answer it.

Everything you can do to a ticket is in that one block:

| | |
|---|---|
| **Answer it** | a stage stopped to ask you something |
| **Start after** | which tickets this one waits for |
| **Ask for changes** | keep the work, put these right |
| **Replan it** | the approach is wrong; buy a new plan |
| **Ship it** | offer what it has as a pull request, whatever the agents said |
| **Reject/cancel it** | stop it |

Anything that has not ended can be cancelled, an idea still in the backlog included — that
is how one you have decided against leaves the board.

Under those, in the order you read them: the **description**, then the plan, then what each
stage made of it. The description comes first because the plan and the runs are answers to
it, and judging work against anything else is how a ticket gets rejected for something it
never asked for.

**Nothing is shown at full length twice.** The plan collapses to its steps; each stage run
collapses to a line — what it was, how it ended, its checks, its tool calls and what it
cost — and the prose opens when you want it.

**Everything that happened** is the whole record, one line per event, and any line with
more behind it opens: what an agent said in full, the arguments a tool was really given,
what a stage cost.

**A stage that failed can be restarted.** A crash — the model service hanging up, a push
that could not reach the remote — parks the ticket with nothing to answer, so the panel
offers **Restart this stage** rather than a question box. It runs again from the top, and
the failed attempt stays in the record beside the one that worked.

## Holding a ticket behind others

`wb wait t43 t37,t40`, `wb new --after`, or the **Start after** box on the panel and the
new-ticket form. You filter it by typing and pick from it — an id is not something anyone
remembers, and a free-text box takes one that does not exist as readily as one that does.
Only tickets that would actually hold it back are offered.

A held ticket runs nothing at all until every one of them has let go, says whose cards it
is behind, and does not say `queued` — a slot coming free would do nothing for it.

**The release is the pull request, not the merge.** What one ticket needs of another is
that it stop committing; after that its branch is final. Waiting for the merge would put
every dependency behind a person. A ticket that was cancelled or given up on releases what
waits on it too: a queue held up by a ticket nobody is working on is the one failure with
no way out.

## Steps

A plan ends with a `STEPS:` list. They cost nothing extra — the plan is writing them
anyway — and you see them when you approve, so approving the plan approves its steps.

Afterwards they are what progress is reported against. The implement stage says `STEP <n>`
as it begins each one, and the card says `step 2/5` instead of `running`. Without it a
twenty-minute stage says nothing but that it is going. An agent that never announces a
step costs the ticket its checklist and nothing else.

**A ticket can be rewritten at any point**, including while it is being worked on. Every
stage is briefed from the ticket as it stands when that stage starts, so a rewrite reaches
everything that has not begun; a stage already running keeps the wording it was given,
because it has already read it.

## Not going stale

A branch is cut from `origin/main` once, and then the ticket works for hours while other
tickets merge. By the time it is offered it is built on a base that no longer exists — and
that, not any difficulty about merging text, is where conflicts come from.

So the base is brought in rather than resolved later. Before a ticket opens its pull
request, and again for every pull request still standing when another one merges, the
branch merges the current base and the standing checks are run against it. A branch that
already has the base is the ordinary case: nothing merges, nothing is recorded, nothing is
re-run and nothing is spent.

When something does merge and the checks then fail, or the merge conflicts outright, the
ticket **blocks** with the failing output or the conflicting paths. Its work stands and its
branch is untouched; what to do about it is a decision rather than another stage.

A pull request you have already answered is left alone. Pushing a merge to it would be a
commit made for reasons nothing to do with your objection, and a branch that has moved past
a change request reads as one that has addressed it.

## Work that outlives its ticket

Work only leaves the workbench by being accepted. A ticket that is cancelled, or given up
on, still has its commits on `wb/<id>` — and nothing could otherwise reach them, since a
worktree is cut from `origin/main` and the guard refuses every path outside it.

```bash
wb new --from t13 "Fix the units" "The headline claim is not supported by table 2."
```

The new ticket's branch is cut from that ticket's, so the earlier work is in its own
worktree from the first stage: readable, editable, and needing no exception to the guard.
Its brief says what it is carrying on from and why that stopped — which is worth more than
the code, because an objection nobody passes on is rediscovered at full price. It is also
the only way it can travel: the objections are events in a database the worktrees
deliberately cannot see.

It is not restricted to tickets that failed. The rule is *start from that ticket's branch
instead of main*, and it reads the same whether the work was abandoned, superseded, or
finished and now being extended.

A stopped ticket that left commits says so on its card and offers **Carry on from this**,
which writes the new ticket already pointed at that branch. That is the only moment it can
be said: a ticket's branch is cut when it is created, so a body that merely *mentions* an
earlier ticket starts from main like any other.

Every objection the earlier ticket drew is passed on, not only the last. One that survived
being answered twice is rejected for the same thing three times, and that it recurred is
the most useful thing about it.
