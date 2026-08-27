---
name: naming-a-ticket
description: How a ticket on this board is named, and how to say a better name for one. Use when writing a ticket, renaming one, or suggesting a name for work that has none.
---

# Naming a ticket

A ticket's name is the line everyone reads and almost nobody reads past: it is what
the board shows, what a pull request is called, and what someone scanning a column
of twenty decides from. It is worth the few seconds.

## What a good one is

- **An imperative verb at or near the front.** _Retry failed pushes_, not _Retries_
  or _Push retry handling_. The name says what the work does to the codebase.
- **Short.** Eight words is plenty; three is often better. Detail belongs in the
  instructions, which every stage reads in full.
- **Distinct.** It must not read like another ticket on the board. _Fix the tests_
  next to _Fix the build_ tells you nothing about which is which.
- **Informative.** Name the thing being changed. _Speed it up_ names nothing;
  _Cache the symbol index between runs_ names both the change and where.
- **No ticket id, no stage, no priority.** The board already knows all three.

## Saying a better name

When you are asked about a name someone is typing, answer in these two lines and
nothing else:

```
NAME: <the better name>
WHY: <one line, saying what was wrong with the one given>
```

If the name you were given is already good, answer with the single word:

```
KEEP
```

Prefer `KEEP`. A name that is merely not the one you would have picked is a good
name — suggest a change only when one of the points above is actually missing.
