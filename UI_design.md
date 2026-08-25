Kanban columns:

Backlog - workbench NEVER touches this. It's for human prep. Humans move tickets to Committed when they're ready to go.

Committed - the queue for work. Take from the top.

Planning - in progress planning

Approval - after planning, leave here for manager to approve

Building - for the implement, review, verify stage

QA - the user checks the outcome locally, and can approve (which means go to PR and merge), or send back through the loop with comments

Done - a history of what was done


UI design:

Follow Trello. Every ticket has a unique number (that's a Trello add on!). Very short title. Git details (expand/collapse). Short description. Progress bullet points on each stage. Conversation. Link to ticket. 

Generally LLMs produce way too much info for humans to read, so key summaries are essential, with links to the long version.

Information for managers:
- Decisions to make now
- Decisions that will be affected in future

Distil the more important aspects, don't dump everything. (some of this can be a new skill?)

Important concept still unresolved:
- Product managers use Kanban and comment there as user representatives
- Coders review PRs and comment there and approve or don't approve

Can the latter also feed back into our Kanban as feedback? 


---

## What of this is built

Built, 2026-08-05: Backlog, Committed, Planning, Approval, Building, Done, and every
part of the card above except conversation. The column after Building is called **Pull
request**, because that is what it is — a ticket goes straight from verify to an offered
pull request, with no stop in between.

Not built, deliberately, and each waiting on the same question:

- **QA.** There is no human stop between verify passing and the pull request opening.
- **Conversation.** No comments on a card. Decided if they are ever added: a comment
  reaches the next stage's brief the way a rejection reason does, so commenting steers
  the work rather than being a notepad beside it.
- **Decisions to make now / affected later.** The board shows the plan and its declared
  scale at the gate, and one block per stage run. Nothing distils beyond that yet.

The question under all three is the one this file already names as unresolved: **where the
product manager sits in the loop**, given that the pull request is where a code review
happens and the board is where the ticket lives. Worth answering with real tickets in
hand rather than in the abstract.
