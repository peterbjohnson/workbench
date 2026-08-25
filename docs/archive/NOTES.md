# Decisions and open questions

What was settled while building, so it is not reopened, and what is still open. Status
belongs to `yarn test`, not to this file; history belongs to `git log`.

## Settled

- **Containers are the right answer for isolating agents, and are out of scope here.**
  Accepted 2026-08-04 as a development project. `protectedPaths` gives sparse-checkout
  exclusion, a guard that refuses writes, and denial of the git commands that could undo
  either — a strong speed bump, not a security boundary. An agent with `Bash` can still
  name an absolute path; nothing inspects `cd`.
- **Worktrees live in `workbench/.worktrees`**, gitignored. Overridable in config.
- **`main` is the base branch.**
- Node's built-in SQLite and test runner, and native TypeScript type-stripping — no build
  step, no test framework, no native database dependency.
- `gray-matter` for agent frontmatter. With the Agent SDK, that is the whole dependency list.
- `claude-opus-5` for all four agents; effort `xhigh` for implement and review, `high` for
  plan and verify.
- **An unreadable verdict from review or verify counts as a rejection.** Silence is not
  approval.
- **Verify may `Write` but not `Edit`**: it can add a probe test, but cannot quietly change
  the implementation it is judging.
- **The review agent gets no `Bash`.** Review reads and changes nothing; denying the shell
  makes that structural rather than instructed. It is handed the diff in its brief.
- **A crash is not a rejection.** A failed stage parks the ticket as blocked rather than
  sending it back to planning.
- **`exactOptionalPropertyTypes` stays off, and optional fields are written plainly.**
  `{ costUsd: undefined }` and an absent `costUsd` mean the same thing here, and
  `JSON.stringify` drops the key on the way to the database. `store.append` reads the
  event back from what it stored, so a subscriber and a later reader see the same object.
- **`src/workbench.ts` is the composition root**, and the only file that imports every
  other. It prints nothing and decides nothing; the CLI supplies `announce`.
- **The orchestrator depends on two named ports, not nine loose functions.** `Workspace`
  is somewhere for a ticket to work; `CodeHost` is where finished work is offered. Git
  and GitHub each answer one of them, and each adapter lives beside the code it adapts —
  `gitWorkspace` in `git/worktree.ts`, `githubHost` in `github/pr.ts` — so the loop
  names its collaborators without knowing what answers them.
- **`stage_finished` keeps carrying `rejected`, `costUsd` and `commit`.** Considered
  splitting them into separate events and declined: they are three genuine facts about
  one run, and separating them would mean more event types, more appends and more cases
  in `applyEvent` to say exactly the same thing.
- **The workbench runs the standing checks, not the verify agent.** An agent reporting
  that the tests passed is a claim; running them here makes it a fact, recorded as
  `checks_run`. A failure rejects the ticket with the output as its reason and calls no
  agent at all, so finding a broken test is the cheapest thing the workbench does rather
  than the most expensive.
- **Verify exists to produce evidence, and its floor is the same at every scale.** The
  review judges whether the change addresses the ticket; verify is the only stage with a
  shell, so if it is not running something it is a second opinion rather than a new one.
  At every scale it shows the ticket's own tests pass *with* the change and fail
  *without* it — the second half is the one nobody checks, and a test that passes either
  way is worse than none. Probing is what scales on top of that.
- **What a scale means is each agent's own business.** The brief states the scale as a
  bare fact; `review.md` reads it as how far to read, `verify.md` as how hard to probe.
  One paragraph in `brief.ts` handed to all three said something slightly wrong to each.
  `implement.md` gets nothing: the plan already sets the size of the work, and its
  instructions already say the best change is a small one.
- **A ticket starts in the backlog, and the workbench never touches it there.** Writing a
  ticket down is not deciding to do it. `nextAction` waits on `backlog` the same way it
  waits at the plan gate, so an idea costs nothing until someone drags it to Committed.
  Both moves are single events (`queued`, `backlogged`) and each is a no-op unless the
  ticket is in the state the other leaves it in — so nothing can pull a running ticket
  off the board.
- **A ticket could only finish if the agents approved it, and none ever did.** Three toys
  accepted; every real ticket died at the cycle cap on objections that were each worth
  making. Review and verify held an absolute veto and the manager had no way to say *that
  will do*, so a reviewer that can always find one more thing always won — and it always
  can. Three changes together: the plan states `DONE WHEN:` and that list is the only thing
  review may judge; anything merely better goes under `LATER:` and becomes a ticket with one
  click; and **Ship it** offers what a ticket has as a pull request from anywhere, so
  disagreement between agents is settled by the manager rather than ending the work.
- **Staleness is dealt with, not conflicts.** A branch cut once from `origin/main` and worked
  on for hours is offered against a base that no longer exists; that is what conflicts are.
  So the base is merged in before a ticket is offered, and again into every standing pull
  request when another one merges, with the standing checks run against it. Considered an
  agent that resolves conflicts and declined: it would be the worst-informed thing in the
  system, holding two diffs and no ticket, and the trivial half of the problem is duplicated
  facts, which are cheaper to delete than to re-resolve for ever.
- **A merge, not a rebase.** Rebasing means force-pushing a branch that may already have a
  pull request, rewriting every commit a standing review was written against.
- **A pull request the manager has answered is not refreshed.** `readVerdict` reads a branch
  that has moved past a change request as having addressed it — true while the only reason
  for a new commit is someone addressing it, and false the moment refreshing is automatic.
  Skipping those is the whole fix; the date test stays as it is.
- **The cycle cap hands over rather than gives up.** Reaching it is not the workbench being
  finished with a ticket, it is the agents failing to agree — so it parks as blocked with
  the objection and the three choices, instead of binning work that has commits. `gave_up`
  is left for the money ceiling, which is a different statement.
- **Scale binds the ceilings; it used to bind nothing.** It reached the agents as one
  sentence in the brief while every stage ran at the same limits. Per-scale frontmatter
  gives a small ticket 60 turns and $5 to implement and 25 and $3 to review, against 200/$20
  and 60/$10. t13's own plan called it small and reviewing it cost more than doing it, on
  every one of its three cycles. Only the ceilings vary — same instructions, same tools,
  same guardrails, validated as strictly as everything else in that frontmatter.
- **A block ends where the next one starts.** `CHANGES:` ran to the end of the message, so a
  reviewer's `LATER:` suggestions arrived as objections the implementer was told to fix.
  Found by reading what a real handover actually said, not by a test.
- **A rejection and a list of corrections are different things, and were not.** t8 and t13
  spent $26.56 between them and delivered nothing. Every one of their six objections was a
  comment on a draft — a wrong number, a claim its own tables contradicted, a constraint
  evaluated at the wrong end of the envelope — and the only verdict available for any of
  them threw the work away and bought a new plan. `CHANGES:` sends the work back to the
  stage that made it, carrying the list; `REJECTED` still means the approach itself is
  wrong. Capped at two rounds per plan: an objection that survives being addressed twice is
  evidence about the approach rather than the execution.
- **The revision cap is a rule, not a spend limit.** It lives in `ticket.ts` beside
  `NEXT_STAGE` rather than in `DEFAULT_POLICY`, because `maxCycles` and `maxTicketUsd` say
  what the manager will pay for and this says what a repeated objection *means*. It also
  keeps `applyEvent` pure — the alternative was threading policy through it for one number.
- **Work outlives its ticket, or it does not exist.** A ticket that is cancelled or given up
  on leaves commits on `wb/<id>` that nothing could reach: the worktree is cut from
  `origin/main` and the guard refuses everything outside it. `--from <id>` cuts the new
  ticket's branch from that one's, so the work is in the new worktree from the first stage.
  Deliberately not restricted by status — *start from that ticket's branch instead of main*
  is the whole rule, and a status list would be a longer rule that says less.
- **The diff is taken against what the ticket was actually cut from.** It used `cfg.base`,
  the *local* branch — the staleness `startPoint` exists to avoid — and for a ticket
  continuing another that would have presented all of the earlier work as this ticket's
  change, handing a reviewer thousands of words to judge as new.
- **The plan declares its own steps; nothing re-reads it to find them.** The ticket asked
  for steps to be extracted *after* approval, which would have meant a fifth model call to
  re-read a plan the workbench already has — against a project that has spent its effort
  cutting exactly that. `SCALE:` was the precedent: a `STEPS:` block costs nothing, and it
  puts the steps in front of the manager at the gate, so approving the plan approves them.
  They are still only *used* after approval, which is what was actually wanted.
- **A stage announcing `STEP n` is turned into an event by the orchestrator, not by a
  runner.** It goes in the `emit` wrapper in `doStage`, so every runner gets it — including
  the fake one, which is what makes the whole path exercisable without spending anything.
  Putting it in `runStage` would have meant the fake runner duplicating the same regex to
  stay honest.
- **The protocol lives in `src/run/protocol.ts`, apart from the runner.** `readScale`,
  `readApproval`, `readSteps` and `readStep` are what a stage *says* and how the workbench
  reads it — not a runtime. The orchestrator needs one of them, and importing them from
  `runStage.ts` would have dragged the Claude SDK into the orchestrator, which is exactly
  the coupling the two named ports exist to avoid.
- **Restarting is its own event, not an answer.** `question_answered` was the only way out
  of `blocked`, so restarting a crashed stage meant answering a question nobody asked, and
  the text landed in the next brief as though it had. `stage_restarted` puts the ticket back
  into its stage carrying nothing: no answer, and no session, because a conversation that
  died is not worth resuming. Guarded like `queued`/`backlogged`, so it cannot reach into
  work that is running. Not offered for `gave_up`: that is a policy stop, and a restart
  walks straight back into the same limit.
- **A ticket is rewritable, at any point, and an edit is an event like everything else.**
  `ticket_edited` carries whichever of title and instructions changed; the other is left
  alone, so the CLI cannot wipe what you wrote by omitting an argument. Nothing is gated
  on status: a ticket you cannot fix is worse than a stage briefed from words you have
  since improved. Each stage is briefed from the ticket as it stands when it starts, so a
  rewrite reaches everything that has not begun and a run already going keeps what it read.
  The log holds every version, because nothing is ever overwritten.
- **The board writes a whole ticket, not a title.** Creating one opens the same form that
  editing does — so what you can say at the start is exactly what you can change later,
  and the instructions field, which is most of what an agent is given, is no longer
  something only the CLI could fill in.
- **React and Vite, and the build step is the board's alone.** The backend keeps its
  no-build property; `ui/` is compiled by Vite into `ui/dist` and served off disk. This
  ends "the Agent SDK and gray-matter are the whole dependency list" — the board costs
  react, react-dom, vite and the react plugin. `wb serve` says so when the board is not
  built, rather than serving a 404 that reads like a broken workbench.
- **No test framework for the board.** What is worth testing is not React: the column
  mapping and the folding of a history into stage runs are pure functions in
  `src/domain/board.ts`, tested with `node:test` like everything else. Adding vitest and
  a DOM to assert that a heading renders would buy nothing the eye does not.
- **`index.html` is served `no-store`; its hashed assets are immutable.** Found by
  rebuilding the board and watching the browser keep the old one — which looks exactly
  like a change that did not work, and costs the time it takes to disbelieve it.
- **`runId` means the stage run, on every event that carries one.** It did not: the
  orchestrator never told `StageRunner` which run it was, so the runners invented ids —
  `message.uuid` per SDK message, `tool_use_id` per tool call, the literal `'resume'`,
  `fake-<stage>-<attempt>` — and a single run's own events each claimed to be a different
  run. The runners are now told, which deleted the fake ids and the counter that existed
  to build one. `reconcile`'s `interrupted` is the one id that names no run, and says so.
  What the field was worth is only visible once it is true: the record now says which
  stage each line came from without anyone inferring it from the order.
- **Tickets come back in creation order.** `ORDER BY ticket_id` sorts as text, so `t10`
  came before `t2`: "take from the top of the queue" quietly meant something else. That
  order is now a default rather than a decision — `moved` events replay over it, and a
  move names a neighbour rather than a position, because a position means something else
  the moment anything else moves.
- **The manager gets both of the agents' "no"s, and neither is rationed.** Review and
  verify choose between rejecting an approach and asking for changes to sound work; the
  manager could only do the expensive one, and only at the plan gate — offered work could
  be sent back through GitHub or not at all. `MAX_REVISIONS` and `maxCycles` exist because
  two agents repeating an objection is evidence about the approach. A person repeating one
  is not, so a manager's request counts no revision and is never converted to a re-plan.
- **`prUrl` is where the work went; `offered` is whether an offer stands.** One field was
  doing both, so a ticket sent back to be reworked had to lose its pull request link to
  stay shippable and restartable — losing it exactly when it is most worth clicking, since
  the objection being answered was written there. `offered` cannot be read off the status:
  `blocked` replaces the status, so a ticket stuck while an offer stood has nowhere else to
  record that it was.
- **What a ticket waits for is said when it is written.** That is the moment you know what
  the work follows; until the form offered it, the only way to say so was to write the
  ticket and then go back into it, which is the kind of second step nobody takes. One
  control does both — the panel holds the selection and sends it on Update, the form sends
  it with everything else — so the two cannot drift apart.
- **What a ticket waits for is picked from the board, not typed.** A free-text box takes
  an id that does not exist as readily as one that does, and nobody remembers ticket ids.
  Only tickets that would actually hold it back are offered: one that has already offered
  its work or ended releases the moment it is chosen, so listing it would be picking
  something that does nothing. The list opens whenever the box has the cursor and says why
  it is empty when it is — drawing nothing at all is indistinguishable from a control that
  does not work, which is exactly how it read on a board where every other ticket had been
  offered or finished.
- **A ticket waiting on several is held until every one of them releases.** `waitsFor` is
  a list and `waits_for` carries the whole set each time rather than a difference — the
  manager picks what it waits for, and that is what they picked.
- **A ticket waiting on another is released by the pull request, not the merge.** What one
  ticket needs of another is that it stop committing; a ticket that needs the code itself
  starts *from* that branch (`continues`). Waiting for the merge would put every dependency
  behind a person, and a forgotten pull request would stop the board. Cancelled and
  given-up tickets release too: nothing else ever would.
- **No CI, deliberately.** The argument for it was that CI is the only participant in the
  loop that cannot report a pass it did not observe — and that hole is closed at source
  now the workbench runs the checks itself. What is left is running a three-second suite
  on pull requests that touch `workbench/`: insurance against a future session forgetting,
  not a structural gap. Revisit when the project exists and there is something to protect.
  Do not re-litigate this on the grounds that "projects have CI"; nothing here deploys.
- **A suggestion names the ticket it proposes.** `LATER:` items were paragraphs, and the
  whole paragraph became the title — of the card, the branch, the pull request and the
  merge commit, one of which now runs to five lines in `git log`. Review and verify write
  `<name> — <what and why>`; the name is the title and the rest is the description. An
  item that arrives unnamed is still cut at a word, so nothing can put a paragraph on a
  card. Wrapped list items now carry on rather than ending the list, which they had to
  before a suggestion had anything long enough to wrap.

## Where to refactor next

### Found by watching t4 delete two files for $1.88

The ticket was "delete these two files". It took five stages, 44 tool calls and
$1.88, and **verify alone was 152 seconds and 42% of the cost.** Nothing failed —
the pull request was exactly the two deletions — but the shape is wrong, and the
reasons are specific rather than "agents are expensive".

All five are done, and **measured** — see below.

### Measured, 2026-08-05

t6 re-ran t4's exact ticket ("remove the count-to-ten script") against the rebuilt
workbench. Same words, same repository, real agents.

| | t4, before | t6, after |
|---|---|---|
| cost | $1.88 | **$0.89** |
| tool calls | 44 | 27 |
| stages | 5 | 4 |

t5, which wrote the script in the first place, cost $1.61 over 21 tool calls.

What the run showed working that had never run for real:

- **The plan wrote its own `SCALE` line** and called both tickets `small`. `wb show`
  prints it at the gate, so the manager approves the self-assessment along with the plan.
- **`checks_run` fired first in verify**, before any agent tool call, and its result went
  into the record rather than into an agent's summary.
- **Verify read what the checks covered and went for the gap.** Its own words: *"compileall
  proved `count_to_ten.py` parses. It never executed it, so it said nothing about what the
  script actually prints — that was the gap to close."* It then produced byte-exact output
  through `od -c`. That is the specialisation working: the deterministic part done
  deterministically, the agent spending its turns on what only it can do.
- **The `about` file reached the agents.** The plan reasoned unprompted that `human_made/`
  is the user's own work and `archive/` is frozen prior art, and declined to touch either.

Still unproven: a genuine session resume. Neither ticket asked a question, so nothing
resumed. That path has still never run for real.

**Halved, not solved.** $0.89 for deleting one six-line file is better than $1.88 and
still a lot. The remaining cost is four agent runs on work that does not need four
opinions, which is a question about the shape of the loop rather than about depth.

### Done

- **Verify had nowhere to put scratch work.** Every ticket now gets
  `<worktreeRoot>/<id>.scratch`, outside the worktree so nothing left in it can reach
  a commit, and the brief tells the stages that can write not to bother tidying it up.
- **The blunt guard rules cost turns.** The `rm -r` ban now judges what the command
  names rather than which flag it carries. A target that cannot be read — `$VAR`, a
  backtick, a glob — is still refused: the point is to know what is being deleted.
- **Verify went looking for things the brief could tell it.** `about` in the config
  names a file describing the project, inlined into every brief. Default `claude.md`.
- **Nothing scaled the ceremony to the work.** The plan ends with
  `SCALE: small|standard|large` and every later stage is told what a proportionate job
  looks like. **No stage is ever skipped** — this is a dial on depth, not on sequence,
  and the manager sees the declared scale at the gate. Silence means `standard`, so
  forgetting to say is never the cheap route to a lighter review.
- **An interruption cost a whole plan.** A stage that stops to ask keeps its session
  id; answering resumes that conversation with just the answer, rather than rebuilding
  the brief and paying again for thinking already done. A resume that fails falls back
  to a fresh run — but only if it had not already spent anything, because re-running
  something half-done would pay twice, which is the thing being fixed.

## What the agents cost, measured

`scripts/toolmix.mjs` reads the event log and the SDK transcripts and prints this. It is
the before-and-after for any change to the tools. Baseline, 226 runs / 3,090 tool calls:

```
  stage        runs  turns  calls  calls/turn  solo%   median ctx   p90 ctx
  plan          59    379    598        1.88    20%        27.9k     44.4k
  implement     68   1278   1527        1.26    77%        54.1k    111.3k
  review        65    366    594        1.97    14%        48.8k     98.5k
  verify        34    454    566        1.35    66%        48.6k     80.2k
```

Two things in that table were not what anyone assumed.

**Plan and review already batch.** At 1.88 and 1.97 calls per turn they are the two
stages doing it well; the "one trivial read at a time" complaint is not about them. What
they do waste is *what* they read — 25% and 12% of their calls are `Glob`, orienting from
scratch on a repository whose shape is the same every ticket.

**Implement is half the bill on its own.** 1,278 turns at a median 54.1k is roughly 69M
of the 137M tokens re-sent across every stage, and 77% of its turns carry exactly one
tool call — a staircase of single `Edit` and single `Bash` turns, each one paying full
context for about 180 characters back. Verify is the same shape, smaller (66% solo).

**The raw context figure flatters any fix.** 137.3M tokens re-sent is 24.9M once cache
reads are priced at a tenth. Quote the billed number; the raw one makes every change look
five times better than it is.

## What the MCP spike settled, and what it did not

Established by running one throwaway `mcp__wb__ping` tool against the SDK:

- The tool is offered to the model as **`mcp__wb__ping`** — server name, then tool name,
  both after `mcp__`. That is the string frontmatter must use and the guard must match.
- `createSdkMcpServer` connects (`mcp_servers: [{name: "wb", status: "connected"}]`), and
  the SDK's bundled zod-to-JSON-Schema walks a *separately installed* zod's internals
  without complaint. `zod` is a peer dependency and was not installed; `tool()` cannot
  build a schema without it.
- `allowedTools` **does not restrict** — the SDK's own docs say it only auto-approves, and
  that `tools` is the option that restricts. So a server registered once for every stage
  puts its tools in every stage's context whatever the frontmatter says. Hence one server
  per run, filtered by that stage's grant.
- `alwaysLoad: true` is required or the tools are deferred behind `ToolSearch`, which
  costs a discovery turn per stage — the saving spent before it is made.

**Still unproven: whether `PreToolUse` fires for an MCP tool call**, and therefore whether
`tool_requested` records one. The spike got as far as the tool being offered and then died
before calling it: this machine's Claude CLI is logged out — `claude auth status` reports
`loggedIn: false`, and a direct call answers "OAuth session expired and could not be
refreshed" — so no credential was available to any of it. `checkCredentials` says exactly
that, correctly. Nothing rests on the hook for safety, because the tool handlers ask
`guard` themselves; what rests on it is the measurement, since MCP calls the hook never
sees are invisible to `scripts/toolmix.mjs` and the after would not be comparable to the
before. One real stage, once someone is logged in, settles it.

One thing to watch while doing that: **`claude -p` prints "Failed to authenticate" and
still exits 0.** `verifyCredentials` treats a non-throwing call as proof the credential
works, so that path alone would call a dead credential healthy. It is not reachable today
— `checkCredentials` refuses first, before any call is made — but it is the check that is
supposed to catch a credential the API rejects, which is the one case no local test can
find, so today it would not catch it.

## Next

**Prune the prose-matching assertions in `agents.test.ts`.** An assertion earns its place
when the expected value comes from the test's own fixture, or when it exercises a branch
or a transform. A few do neither and quote the source's own prose back at it — the worst
encodes the markdown bold *and the line wrap*, so reflowing a paragraph fails it. They are
change-detectors that punish exactly the edit you most want someone to make. Most went
with `HOW_DEEP`; what is left is around the scratch-directory paragraph and "Paths outside
it are refused".

## Open

- **The base is taken in; the branch's own remote is not.** `refresh` fetches `origin/main`
  and merges it — *Staleness is dealt with, not conflicts*, above — and nothing anywhere
  looks at `origin/wb/<id>`. `openPr` is a bare `git push -u origin <branch>`, so a commit
  on the branch's remote that the worktree has not seen rejects the push and blocks the
  ticket. t61, when **Update branch** was clicked on its pull request seventeen seconds
  before the workbench pushed. It does not heal itself either: refresh merges `main`
  locally while the remote has merged `main` its own way, two different merge commits, and
  `merge-base --is-ancestor` answers up-to-date for ever after. The fix is the same idea
  one step further — fetch and merge `origin/<branch>` before the base, so the push is
  always a fast-forward. A pull request is a place people commit to, and the update
  button and an accepted suggestion both belong in the worktree anyway, where the next
  stage can read them.
- **A merged workbench change does nothing until `wb serve` is restarted, and nothing says
  so.** Node caches modules at import and the process runs from `src/` in the working
  tree, so a fix that is merged, on `main` and on disk is still not running. The workbench
  that blocked t61 was started at 22:58; the base-refresh it needed merged at 23:46, and
  the ticket's history has no `refreshed` event because that code was not in the process.
  Diagnosing from source that is not the source running is the expensive kind of wrong.
  Cheapest fix: record the base sha `wb serve` started from, and have `wb list` say when
  `origin/main` has moved past it.
- **Four agent runs is still the floor, whatever the scale.** t6 halved t4's cost to
  $0.89, and the remaining spend is four opinions on a one-file deletion. Depth is now
  proportionate; the number of runs is not, and that is a question about the shape of the
  loop rather than about how deep each stage goes. The spec's four stages were not written
  with a six-line deletion in mind. Worth reopening only with a real project's tickets in
  hand, not with more exercises.
- **Session resume has never run for real.** Neither test ticket asked a question, so
  nothing resumed. Run one ticket vague enough to make an agent ask, and watch whether
  answering continues the conversation or starts it again.
- **The workbench has nothing of its own to work on.** The repository holds `archive/` and
  `human_made/`, both frozen prior art, and a `claude.md` saying the project's brief is the
  user's to write. Until that exists, tickets are exercises. `protectedPaths` also excludes
  `workbench/` from every ticket worktree, so it cannot work on itself.
