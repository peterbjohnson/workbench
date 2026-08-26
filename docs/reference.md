# Reference

Commands, configuration, limits, the HTTP API and the tools agents are given.

> Much of this page mirrors things the code already states — `wb --help`, the comments on
> every `Config` field, the frontmatter of each `agents/*.md`. It is written by hand today
> and is the first candidate for being generated from those, so that it cannot drift.

## Commands

`wb --help` is the authority. Every command except `serve` talks to a running workbench
over HTTP, so the board and the command line can do exactly the same things.

<!-- generated:commands -->

```
workbench — a board of tickets that agents work through

  wb init [dir]                start a workbench in a repository, in .workbench/
  wb auth                      whether the workbench can reach the model service
  wb update                    fetch whatever has been pushed since this copy was installed
  wb serve                     run the workbench: the API and the orchestrator
  wb new <title> [body]        write a ticket down, in the backlog
  wb new --from <id> <title> [body]
                               carry on from a ticket, starting on its branch
  wb new --no-approval <title> [body]
                               let its plan go straight on to being built
  wb new --after <a,b> <title> [body]
                               hold it until those tickets offer their work or end
  wb edit <id> <title> [body]  rewrite it; the instructions are left alone if omitted
  wb queue <id>                commit to it: the workbench may now start it
  wb backlog <id>              take it back out of the queue, before it starts
  wb move <id> [before]        put it in front of another ticket, or last
  wb wait <id> <a,b|none>      hold it until those tickets offer their work or end
  wb list                      show every ticket and where it is
  wb show <id>                 one ticket, with everything that happened to it
  wb approve <id>              approve a plan, letting implementation start
  wb reject <id> <reason>      send it back to be planned again; the reason goes to the plan
  wb changes <id> <text>       keep the work and put these right; back to implement
  wb answer <id> <text>        answer a blocked ticket and let it carry on
  wb restart <id>              run a failed stage again, from the top
  wb ship <id>                 offer what it has as a pull request, and decide there
  wb cancel <id> [why]         stop a ticket, including one that is running
  wb wip <n>                   how many tickets may run at once

Every command except "init", "auth", "update" and "serve" talks to a running
workbench over HTTP, so the board and this command line can do exactly the same
things.

"wb serve" calls real agents and spends real money.
```

<!-- /generated:commands -->

## What each stage may do

Read from `agents/*.md`. A struck-through tool is refused outright rather than merely
not offered — leaving one out of `allowedTools` only stops it being auto-approved, and
the agent still calls it and still loses the turn.

<!-- generated:stages -->

| stage | model | effort | turns | budget | tools |
|---|---|---|---|---|---|
| **plan** | claude-opus-5 | high | 40 | $5 | `Read`, `Grep`, `mcp__wb__map`, `mcp__wb__where`, `AskUserQuestion`, ~~`Write`~~, ~~`Edit`~~, ~~`Bash`~~, ~~`Glob`~~ |
| **implement** | claude-opus-5 | xhigh | 200 | $20 | `Read`, `Write`, `Edit`, `Grep`, `Bash`, `mcp__wb__map`, `mcp__wb__where`, `AskUserQuestion`, ~~`Glob`~~ |
| **review** | claude-opus-5 | xhigh | 60 | $10 | `Read`, `Grep`, `mcp__wb__map`, `mcp__wb__where`, `AskUserQuestion`, ~~`Write`~~, ~~`Edit`~~, ~~`Bash`~~, ~~`Glob`~~ |
| **verify** | claude-opus-5 | high | 80 | $10 | `Read`, `Write`, `Grep`, `Bash`, `AskUserQuestion`, ~~`Edit`~~, ~~`Glob`~~ |

<!-- /generated:stages -->

## Where the workbench keeps things

`wb init` writes `.workbench/` into your repository. A workbench's **home** is wherever
its `workbench.config.json` is — found by walking up from the working directory — and the
repository it works on is the one that home sits in. `WB_HOME` overrides the search.

```
.workbench/workbench.config.json   the branch to work from, and the checks
.workbench/skills/                 your own expertise, one directory each
.workbench/agents/                 optional: your version of a stage, if you want one
.workbench/data/                   the event log, in SQLite         (gitignored)
.workbench/.worktrees/             one per running ticket            (gitignored)
```

## Configuration

Defaults are in `src/config.ts`, where every field carries a comment saying what it is
for. Override any of them in `.workbench/workbench.config.json`, or from the **Settings**
page on the board, which says of each whether changing it waits for a restart.

```json
{
  "base": "main",
  "checks": ["python3 -m compileall -q ."],
  "about": "claude.md",
  "protectedPaths": ["package.json"]
}
```

**`checks` are the standing suite, and the workbench runs them itself** — in the ticket's
worktree, at the start of verify, not by the verify agent. A pass is then something
observed and written into the record rather than something an agent reports. If any check
fails the ticket goes straight back to planning with the failure output as the reason and
**no agent is called at all**, so discovering a broken test is the cheapest thing the
workbench does rather than the most expensive.

With none set, verify's `APPROVED` only ever means "I could not break it", and `wb serve`
says so loudly at startup. A check must write nothing: it runs inside the worktree it is
judging, and anything it leaves behind lands in the pull request.

**`about`** is a file describing the project, put in front of every stage. Facts that do
not change between tickets — what this repository is, where things live — cost an agent
several tool calls every time it rediscovers them. Keep it short: every stage of every
ticket reads it. Point it at nothing and the section is left out.

**`protectedPaths`** are read-only to agents and absent from every ticket worktree. The
home is always one of them, worked out rather than configured; anything you add joins it.
A path may be a file or a directory.

**`port`** (4600) is where `wb serve` listens and where every other `wb` command looks for
it. One workbench per repository is the intended way to run this, and the only thing in
the way is that they all start out wanting the same port — so a `wb serve` that finds it
taken says who is on it and offers the next free one, writing the answer here if you take
it. Two workbenches for the *same* repository is refused rather than moved: they would
open one database between them.

## Limits

A ticket cannot run away with your money.

| | |
|---|---|
| `wipLimit` (2) | how many tickets may have a stage running at once |
| `maxCycles` (3) | how many times one ticket may be planned before the workbench stops |
| `maxTicketUsd` (50) | what one ticket may cost, across every stage and every cycle |

Every run's cost is recorded on the ticket, so `wb show` says what it has spent. A ticket
that hits a limit is **given up on** — a different thing from blocked, which means stuck
and answerable. One the wip limit is holding back says `queued` on its card.

**Scale is not advice.** A plan says whether the work is `small`, `standard` or `large`,
and that sets the turns, the budget and the effort every later stage runs under — a
`small` ticket gives implement 60 turns and $5 where a standard one gets 200 and $20. A
plan that says nothing gets `standard`, so forgetting is never the cheap way to a lighter
review.

**No stage is ever skipped.** A `small` ticket is still implemented, still reviewed
adversarially and still verified; each is asked for a proportionate look rather than the
maximum one.

## Skills

`.workbench/skills/<name>/SKILL.md` is written expertise: how a report is structured here,
how Python is written here. **The workbench ships none** — how your repository writes
Python is yours to say.

Every stage gets every skill, named in its brief with its description, and reads one with
the `Skill` tool. The **Skills** page on the board reads and writes them, as **Agents**
does for the four stage definitions.

Nothing is rationed per stage: review has to judge work against the standard implement
wrote it to, so giving them different expertise would be arranging a disagreement. The
`description` is the whole trigger — it is what an agent reads to decide whether a skill
is worth opening — so it says what the skill is *and when to use it*.

## Tools

Every stage's brief lists every file in the worktree, with its line count and what is
defined in it, worked out from the source before the run starts. That costs no turn at
all, which is why `Glob` is refused rather than merely left out: leaving a tool out of
`allowedTools` only stops it being auto-approved, and the agent still calls it and still
loses the turn.

Two tools go further, and both are read-only:

- **`mcp__wb__map`** — what is defined in a file or directory, with the lines each thing
  spans, so a `Read` can be aimed instead of pulling the whole file. Markdown gets its
  headings, tables and figures.
- **`mcp__wb__where`** — every use of a name, grouped into definition, import, call with
  its argument count, attribute and assignment. A caller the diff forgot shows up as a
  call whose argument count no longer matches its definition.

`Read` and `Grep` stay. A tool with a built-in rival earns the schema cost of both and the
usage of one, so the only tools added are ones nothing built-in already does. Both are
honest about their limits in their own descriptions: Python and JavaScript are parsed but
not resolved, so two functions sharing a name are both reported, and prose is not searched
at all.

`src/code/` is where the parsing lives — Python from Python's own `ast`, JavaScript from
`ts.createSourceFile`, Markdown from a scan. Nothing is installed to do any of it.

## HTTP API

`wb serve` is the only process that touches the database or runs agents.

| | |
|---|---|
| `GET /tickets` | every ticket |
| `POST /tickets` | create one — `{title, body, from?, requiresApproval?, waitsFor?}` |
| `GET /tickets/:id` | one ticket and everything that happened to it |
| `POST /tickets/:id/edit` | rewrite it — `{title?, body?}`; what is absent is left alone |
| `POST /tickets/:id/queue` | commit to it |
| `POST /tickets/:id/backlog` | take it back out of the queue |
| `POST /tickets/:id/move` | put it in front of another — `{before}`; null for last |
| `POST /tickets/:id/wait` | hold it — `{tickets}`; the whole set each time, empty lets go |
| `POST /tickets/:id/approve` | approve a plan |
| `POST /tickets/:id/reject` | send it back to be planned again — `{reason}` |
| `POST /tickets/:id/changes` | keep the work and put these right — `{changes}` |
| `POST /tickets/:id/answer` | answer a blocked ticket — `{answer}` |
| `POST /tickets/:id/restart` | run a failed stage again, from the top |
| `POST /tickets/:id/ship` | offer what it has as a pull request |
| `POST /tickets/:id/cancel` | stop a ticket — `{reason}` |
| `POST /name-check` | a better name for a ticket being written — `{title, body}`; `{name: null}` if the one given is fine |
| `GET`/`PUT /policy` | the limits — `PUT` takes any of them, and leaves the rest |
| `GET`/`PUT /settings` | everything the workbench is set to |
| `GET /agents`, `GET /skills` | each file, with its text and what it declares |
| `PUT /agents/:stage`, `PUT /skills/:name` | save one — `{text}`; refused if it would not load |
| `GET /events` | server-sent events, live |

Nothing here decides anything: each endpoint appends one event and lets the rules react.

## Layout

```
agents/           one markdown file per stage: its job, its model, the tools it may use
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
src/cli/          the command line
src/code/         parsing source for the map and where tools
```
