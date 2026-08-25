import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { Doc, DocKind } from '../../src/api/documents.ts';
import { COLUMNS, columnFor, needsYou, waitingForSlot } from '../../src/domain/board.ts';
import { heldBy, type Policy } from '../../src/domain/rules.ts';
import { ended, type Ticket } from '../../src/domain/ticket.ts';
import { Card } from './Card.tsx';
import { Detail } from './Detail.tsx';
import { Docs } from './Docs.tsx';
import { Settings } from './Settings.tsx';
import { TicketForm } from './TicketForm.tsx';
import { wb } from './wb.ts';

/** The two columns you move a card between by hand. Everywhere else it moves itself. */
const BACKLOG = 'Backlog';
const COMMITTED = 'Committed';

/**
 * What the address says while a ticket is being written rather than read. On its
 * own for a fresh one; `new:t13` for one carrying on from t13, which is the only
 * way `continues` gets set — a ticket's branch is cut when it is created, so there
 * is no later moment to say it in.
 */
const NEW = 'new';

/** The ticket a new one carries on from, when the address says so. */
function continuing(selected: string | null): string | null {
  return selected !== null && selected.startsWith(`${NEW}:`)
    ? selected.slice(NEW.length + 1)
    : null;
}

/**
 * The four pages. The board is the workbench working; the other three are the
 * workbench itself — what each stage is told, what expertise it is handed, and
 * what it all runs under. They were only ever files on disk and a database, so
 * changing any of them meant leaving the board.
 *
 * The address holds the page, so one can be linked to and survives a reload —
 * the same way a ticket does. Anything else in it is a ticket, which is why the
 * board is what an unrecognised address falls back to.
 */
const TABS = ['Board', 'Agents', 'Skills', 'Settings'] as const;

type Tab = (typeof TABS)[number];

function tabInHash(hash: string): Tab {
  return TABS.find((tab) => tab.toLowerCase() === hash) ?? 'Board';
}

/** Which column a ticket may be dragged into, if any. */
function dropTarget(t: Ticket): string | null {
  if (t.status === 'backlog') return COMMITTED;
  if (t.status === 'queued') return BACKLOG;
  return null;
}

export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The whole policy, not only the limit it prints: the same limits decide which
  // cards are waiting on a slot, and asking the rule needs all of them.
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [version, setVersion] = useState(0);
  const [at, setAt] = useState(idInHash);
  const [dragging, setDragging] = useState<Ticket | null>(null);
  // The agent and skill files, held here rather than in the page that shows them:
  // the tabs count them, so they are wanted whichever page you are on.
  const [docs, setDocs] = useState<Record<DocKind, Doc[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Anything appended redraws the board. No polling, and no refresh button. */
  useEffect(() => {
    const events = new EventSource('/events');
    events.onmessage = () => setVersion((v) => v + 1);
    return () => events.close();
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([wb.tickets(), wb.policy()])
      .then(([ts, p]) => {
        if (!live) return;
        setTickets(ts);
        setPolicy(p);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, [version]);

  // Read once. Nothing appends an event when one is saved, so there is nothing for
  // the event stream to redraw off — the page that saves one says what it became.
  useEffect(() => {
    let live = true;
    Promise.all([wb.docs('agent'), wb.docs('skill')])
      .then(([agent, skill]) => live && setDocs({ agent, skill }))
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, []);

  // The page, and the ticket on it, are both in the address — so a card can be
  // linked to and survives a reload, which is what "link to ticket" asks for.
  useEffect(() => {
    const onHash = () => setAt(idInHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const act = useCallback(async (work: Promise<unknown>) => {
    try {
      await work;
      setError(null);
    } catch (e: unknown) {
      setError(describe(e));
    }
  }, []);

  const move = useCallback(
    (t: Ticket, column: string) => {
      // Dropping ends the drag here rather than waiting for `dragend`: the card is
      // about to be re-rendered into another column, and a source element that
      // disappears mid-drag never sends one — leaving the board lit up for ever.
      setDragging(null);
      // Dropped back where it came from: the column is the board behind the cards,
      // so that means the end of it rather than a move between columns.
      if (columnFor(t) === column) return void act(wb.move(t.id, null));
      if (dropTarget(t) !== column) return;
      void act(column === COMMITTED ? wb.queue(t.id) : wb.backlog(t.id));
    },
    [act],
  );

  /** Dropped on a card: the dragged one goes in front of it, in the board's order. */
  const reorder = useCallback(
    (t: Ticket, before: Ticket) => {
      setDragging(null);
      if (t.id !== before.id) void act(wb.move(t.id, before.id));
    },
    [act],
  );

  const tab = tabInHash(at ?? '');
  // Everything in the address that is not one of the four pages is a ticket.
  const selected = tab === 'Board' ? at : null;
  const waiting = tickets.filter(needsYou).length;

  /**
   * How much is on each page, on its own tab. The board counts what has not ended
   * — a finished ticket is still on it, and counting those would climb for ever
   * and say nothing. Settings has no count: one page, always the same size.
   */
  const counts: Record<Tab, number | null> = {
    Board: tickets.filter((t) => !ended(t)).length,
    Agents: docs?.agent.length ?? null,
    Skills: docs?.skill.length ?? null,
    Settings: null,
  };

  /** What one page saved, kept where the count is read from. */
  const saved = (kind: DocKind) => (doc: Doc) =>
    setDocs((held) =>
      held === null
        ? held
        : { ...held, [kind]: held[kind].map((d) => (d.name === doc.name ? doc : d)) },
    );
  const from = continuing(selected);
  const writing = selected === NEW || from !== null;

  // Which cards are next rather than idle. One count for the whole board, so every
  // card is judged against the same load — and none before the policy has arrived.
  const running = tickets.filter((t) => t.running).length;
  const held = (t: Ticket) => heldBy(t, tickets);
  const queued = (t: Ticket) =>
    policy !== null && waitingForSlot(t, running, policy, held(t).length > 0);

  return (
    <>
      <header>
        <h1>Workbench</h1>
        <nav className="tabs">
          {TABS.map((name) => (
            <a
              key={name}
              className={name === tab ? 'picked' : ''}
              href={`#${name === 'Board' ? '' : name.toLowerCase()}`}
            >
              {name}
              {counts[name] !== null && <span className="count"> ({counts[name]})</span>}
            </a>
          ))}
        </nav>
        {waiting > 0 && <span className="waiting">{waiting} waiting on you</span>}
        {policy !== null && <span className="quiet">{policy.wipLimit} at a time</span>}
      </header>

      {error !== null && <div className="error">{error}</div>}

      {tab === 'Agents' && (
        <Docs
          kind="agent"
          docs={docs?.agent ?? null}
          onSaved={saved('agent')}
          empty="No agent files."
        />
      )}
      {tab === 'Skills' && (
        <Docs
          kind="skill"
          docs={docs?.skill ?? null}
          onSaved={saved('skill')}
          empty="No skills yet. They live in the workbench's skills/ directory."
        />
      )}
      {tab === 'Settings' && <Settings onSaved={() => setVersion((v) => v + 1)} />}

      {tab === 'Board' && (
        <div className="board">
          {COLUMNS.map((column) => (
            <Column
              key={column.name}
              name={column.name}
              tickets={tickets.filter((t) => columnFor(t) === column.name)}
              queued={queued}
              held={held}
              // The backlog is where a ticket starts, so that is where writing one
              // belongs — at the top of the column it will appear in, rather than in
              // the header beside things that are about the whole board.
              action={
                column.name === BACKLOG ? (
                  <button className="go new" type="button" onClick={() => open(NEW)}>
                    New ticket
                  </button>
                ) : undefined
              }
              // Its own column too, where the drop means the end of it. Anywhere a
              // card can land says so before it is dropped rather than after.
              accepts={
                dragging !== null &&
                (dropTarget(dragging) === column.name || columnFor(dragging) === column.name)
              }
              dragging={dragging}
              onDrop={() => dragging && move(dragging, column.name)}
              onDropOn={(before) => dragging && reorder(dragging, before)}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onOpen={open}
            />
          ))}
        </div>
      )}

      {writing && (
        <aside>
          <h2>{from === null ? 'New ticket' : `Carrying on from ${from}`}</h2>
          <div className="meta">
            {from === null
              ? 'It waits in the backlog until you commit to it.'
              : `It starts on ${from}'s branch, so that work is in its worktree from the ` +
                `first stage, and its brief says what stopped ${from}. Then the backlog, as usual.`}
          </div>
          <TicketForm
            submitLabel="Create"
            askAboutApproval
            tickets={tickets}
            onCancel={() => open(null)}
            // Straight into the ticket that was just written, which is where you
            // decide whether to commit to it.
            onSubmit={(fields) =>
              act(
                wb
                  .create(fields.title, fields.body, {
                    from: from ?? undefined,
                    requiresApproval: fields.requiresApproval,
                    waitsFor: fields.waitsFor,
                  })
                  .then((t) => open(t.id)),
              )
            }
          />
        </aside>
      )}

      {selected !== null && !writing && (
        <Detail
          id={selected}
          version={version}
          // The whole board, so a suggestion already made into a ticket can say
          // which one rather than offering to make it again.
          tickets={tickets}
          onAct={act}
          onClose={() => open(null)}
        />
      )}
    </>
  );
}

/** The panel is in the address, so a ticket can be linked to and survives a reload. */
function open(id: string | null): void {
  location.hash = id ?? '';
}

function Column(props: {
  name: string;
  tickets: Ticket[];
  /** Something to do in this column, under its heading. Only the backlog has one. */
  action?: ReactNode;
  /** Whether a card is next for a slot — the same judgement for every column. */
  queued: (t: Ticket) => boolean;
  /** The tickets a card is held behind. */
  held: (t: Ticket) => Ticket[];
  accepts: boolean;
  /** The card being dragged, so a card can say whether it is a place to land. */
  dragging: Ticket | null;
  onDrop: () => void;
  onDropOn: (before: Ticket) => void;
  onDragStart: (t: Ticket) => void;
  onDragEnd: () => void;
  onOpen: (id: string) => void;
}) {
  const { name, tickets, accepts, dragging } = props;

  return (
    <div
      className={`col${accepts ? ' drop' : ''}`}
      // Only a column that would accept this card allows the drop, so an illegal
      // move shows as one before it is attempted rather than as an error after.
      onDragOver={(e) => accepts && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
    >
      <h2>
        {name} {tickets.length > 0 && <span>({tickets.length})</span>}
      </h2>
      {props.action}
      {tickets.map((t) => (
        <Card
          key={t.id}
          ticket={t}
          queued={props.queued(t)}
          held={props.held(t)}
          // Every card, not only the two that change column: order is the queue,
          // and a card that cannot be moved cannot be put at the front of it.
          draggable
          accepts={dragging !== null && dragging.id !== t.id && name === columnFor(dragging)}
          onDragStart={() => props.onDragStart(t)}
          onDragEnd={props.onDragEnd}
          onDrop={() => props.onDropOn(t)}
          onOpen={() => props.onOpen(t.id)}
        />
      ))}
    </div>
  );
}

function idInHash(): string | null {
  return location.hash.slice(1) || null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
