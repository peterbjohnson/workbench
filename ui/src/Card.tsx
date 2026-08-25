import { needsYou, salvageable } from '../../src/domain/board.ts';
import type { Ticket } from '../../src/domain/ticket.ts';

/**
 * What a card says at a glance: which ticket, what it is, and whether it is
 * moving, stuck, or waiting on you. Everything else is one click away.
 */
export function Card(props: {
  ticket: Ticket;
  /**
   * Next to run, once something finishes. A fact about the board rather than about
   * the ticket — how many others are running, and how many may — so it is handed
   * in rather than worked out here.
   */
  queued: boolean;
  /** The tickets this one is held behind. Same reason: not its own fact. */
  held: Ticket[];
  draggable: boolean;
  /** Whether the card being dragged would land in front of this one. */
  accepts: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onOpen: () => void;
}) {
  const t = props.ticket;
  // Done holds everything finished, and "we stopped it" is not "it was accepted".
  const stopped = t.status === 'cancelled' || t.status === 'gave_up';
  const marks = [
    stopped && <span key="stopped">{t.status === 'gave_up' ? 'given up' : 'cancelled'}</span>,
    needsYou(t) && (
      <span key="needs" className="flag">
        needs you
      </span>
    ),
    t.running && (
      <span key="running" className="running">
        {/* Which step, when the stage has said. "running" alone says nothing about
            how far along a twenty-minute stage is. */}
        {t.step !== null && t.steps.length > 0 ? `step ${t.step}/${t.steps.length}` : 'running'}
      </span>
    ),
    props.queued && (
      <span key="queued" className="queued">
        queued
      </span>
    ),
    // Not "queued": a slot coming free would do nothing for it. Who it is behind
    // is the only useful thing to say, and the reason it is not moving.
    props.held.length > 0 && (
      <span key="held" className="queued">
        waits for {props.held.map((h) => h.id).join(', ')}
      </span>
    ),
    // Work on the branch of a ticket that was never accepted is otherwise
    // invisible, and nobody salvages what they do not know is there. Opening the
    // card is where it can be done.
    salvageable(t) && (
      <span key="left" className="flag">
        {t.commits.length} commit{t.commits.length === 1 ? '' : 's'} to salvage
      </span>
    ),
    t.continues !== null && <span key="from">from {t.continues}</span>,
    t.revisions > 0 && <span key="revisions">revision {t.revisions}</span>,
    t.scale !== 'standard' && t.plan !== null && <span key="scale">{t.scale}</span>,
    t.costUsd > 0 && <span key="cost">${t.costUsd.toFixed(2)}</span>,
  ].filter(Boolean);

  return (
    <button
      type="button"
      className={`card${needsYou(t) ? ' needs' : ''}${t.running ? ' busy' : ''}${
        props.queued ? ' queued' : ''
      }${props.accepts ? ' before' : ''}`}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      // Dropping on a card puts the dragged one in front of it. The column behind
      // means the end, so the drop must not reach it as well.
      onDragOver={(e) => props.accepts && e.preventDefault()}
      onDrop={(e) => {
        if (!props.accepts) return;
        e.preventDefault();
        e.stopPropagation();
        props.onDrop();
      }}
      onClick={props.onOpen}
    >
      <div className="top">
        <span className="id mono">{t.id}</span>
        {marks}
      </div>
      <div className={stopped ? 'title stopped' : 'title'}>{t.title}</div>
    </button>
  );
}
