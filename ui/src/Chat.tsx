import { useEffect, useRef, useState } from 'react';

import { chatTurns, withoutProposals, type Offered } from '../../src/domain/board.ts';
import type { Event } from '../../src/domain/events.ts';
import { wb } from './wb.ts';

/**
 * The conversation about one ticket, and the things it has offered to do about it.
 *
 * The turns are read out of the ticket's own events, which is where a chat is kept:
 * the pane redraws off the same stream everything else does, and reopening it reads
 * the conversation back rather than starting a new one.
 *
 * It sits beside the ticket panel rather than inside it, and scrolls on its own, so
 * a conversation that runs long does not push the rest of the ticket out of reach.
 */
export function Chat({
  id,
  events,
  onAct,
}: {
  id: string;
  events: Event[];
  onAct: (work: Promise<unknown>) => Promise<void>;
}) {
  const { turns } = chatTurns(events);
  const [text, setText] = useState('');
  /** Whether a reply is in flight. One turn at a time, so Send waits for it. */
  const [thinking, setThinking] = useState(false);
  /**
   * Whether the pane is open, once you have said. Held here rather than read off the
   * DOM because the panel re-renders on every event, and anything uncontrolled would
   * fold itself back up mid-conversation.
   */
  const [open, setOpen] = useState<boolean | null>(null);
  const showing = open ?? turns.length > 0;
  const turnList = useRef<HTMLDivElement>(null);

  /* The pane is open on this ticket, so a turn about it is coming. Almost all of
     what one used to cost was starting something to answer it, and told now that is
     over before the first thing is typed — which is the whole point of paying it
     here rather than when Send is pressed. Told on the rail as well as open: the
     count is there to be clicked. */
  useEffect(() => {
    void wb.warmChat(id).catch(() => {});
  }, [id]);

  /* The newest turn is the one worth seeing, so the scroller starts at the bottom
     and goes back there as the conversation grows. */
  useEffect(() => {
    const list = turnList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns.length, thinking, showing]);

  const say = () => {
    const message = text.trim();
    if (message === '' || thinking) return;
    setThinking(true);
    setText('');
    void onAct(wb.chat(id, message)).finally(() => setThinking(false));
  };

  /* Collapsed, the whole column is the way back in: the icon says what it is and
     the count says how much of it there is, which is all a fold ever said. */
  if (!showing)
    return (
      <button
        type="button"
        className="chatrail"
        aria-label={`Chat (${turns.length} messages)`}
        onClick={() => setOpen(true)}
      >
        <Bubble />
        {turns.length}
      </button>
    );

  return (
    <section className="chatpane">
      <header>
        <Bubble />
        Chat{turns.length > 0 && ` (${turns.length})`}
        <button type="button" onClick={() => setOpen(false)}>
          Hide
        </button>
      </header>

      <div className="turns" ref={turnList}>
        {turns.length === 0 && (
          <div className="box quiet">
            Nothing said yet. It has read the ticket, the plan and what the stages made of it, and
            it can read the code — it cannot change anything except by proposing it.
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={`turn ${turn.role}`}>
            <div className="who">{turn.role === 'manager' ? 'You' : 'Chat'}</div>
            {withoutProposals(turn.text)}
            {turn.proposals.map((proposal) => (
              <Offer
                key={proposal.at}
                proposal={proposal}
                onAccept={() => onAct(wb.acceptProposal(id, proposal.at))}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Above the composer rather than at the end of the turns: what says the reply is
          coming has to be where you are looking when you send, whatever the scroller is
          showing. */}
      {thinking && (
        <div className="waiting" role="status">
          Thinking
          <span className="dots" aria-hidden="true">
            …
          </span>
        </div>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          say();
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder="what about this ticket…"
          aria-label="what about this ticket"
          onChange={(e) => setText(e.target.value)}
          /* Enter sends, as it does everywhere else in this panel; a newline is
             shift-enter. */
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="go" disabled={thinking}>
          Send
        </button>
      </form>
    </section>
  );
}

/** What marks the chat in both of its forms. */
function Bubble() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 3.5h12v8H6.5L3.5 14v-2.5H2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One thing the chat offered to do, and the button that does it. Accepting appends
 * exactly the event the equivalent button in the panel above appends — the chat is a
 * way of reaching those actions rather than a way around them, so an offer that
 * breaks that action's own rule is refused and says why.
 */
function Offer({ proposal, onAccept }: { proposal: Offered; onAccept: () => Promise<void> }) {
  /**
   * Whether this offer's own accept is in flight. The server refuses a second one
   * anyway; this is so a double-click is nothing rather than an error to read.
   */
  const [accepting, setAccepting] = useState(false);
  const what = [proposal.title, proposal.body, proposal.text]
    .filter((part) => part !== undefined && part.trim() !== '')
    .join('\n\n');

  return (
    <div className="offer">
      <div>
        <b>{proposal.action}</b> — {proposal.why}
        {what !== '' && <div className="what">{what}</div>}
      </div>
      {proposal.accepted ? (
        <span className="quiet">accepted</span>
      ) : (
        <button
          type="button"
          className="go"
          disabled={accepting}
          onClick={() => {
            setAccepting(true);
            void onAccept().finally(() => setAccepting(false));
          }}
        >
          Accept
        </button>
      )}
    </div>
  );
}
