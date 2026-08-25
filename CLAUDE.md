# Workbench

A board of tickets that agents work through. `README.md` is what it does and how to run
it; `docs/design.md` is why it is shaped this way, and settled questions live there
rather than being reopened.

## Where to work

**Start with `EnterWorktree`, and commit there.** Not in the checkout.

Sessions share one working tree and `git checkout` is global to it, so two at once means
one session's commit landing on the other's branch — twice in one morning, both times
work that was right and went somewhere wrong. It also means a checkout moving under a
session that is midway through checking its work: the suite passes, and it passed on a
tree that session was no longer standing in. The workbench gives every ticket a
worktree for exactly this reason, and the one thing it cannot give one to is work on
itself. That is this repository, so every session here needs to make its own.
