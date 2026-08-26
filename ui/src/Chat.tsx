import { useState } from 'react';

import { chatTurns, type Offered } from '../../src/domain/board.ts';
import type { Event } from '../../src/domain/events.ts';
import { withoutProposals } from '../../src/run/protocol.ts';
import { wb } from './wb.ts';

/**
 * The conversation about one ticket, and the things it has offered to do about it.
 *
 * The turns are read out of the ticket's own events, which is where a chat is kept:
 * the pane redraws off the same stream everything else does, and reopening it reads
 * the conversation back rather than starting a new one.
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
   * Whether the pane is open, once you have said. Held here rather than left to the
   * `<details>` because the panel re-renders on every event, and an uncontrolled one
   * would fold itself back up mid-conversation.
   */
  const [open, setOpen] = useState<boolean | null>(null);

  const say = () => {
    const message = text.trim();
    if (message === '' || thinking) return;
    setThinking(true);
    setText('');
    void onAct(wb.chat(id, message)).finally(() => setThinking(false));
  };

  return (
    <details
      className="chat"
      open={open ?? turns.length > 0}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Chat{turns.length > 0 && ` (${turns.length})`}</summary>

      {turns.length === 0 && (
        <div className="box quiet">
          Nothing said yet. It has read the ticket, the plan and what the stages made of it, and it
          can read the code — it cannot change anything except by proposing it.
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

      {thinking && <div className="turn agent quiet">thinking…</div>}

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
    </details>
  );
}

/**
 * One thing the chat offered to do, and the button that does it. Accepting appends
 * exactly the event the equivalent button in the panel above appends — the chat is a
 * way of reaching those actions rather than a way around them, so an offer that
 * breaks that action's own rule is refused and says why.
 */
function Offer({ proposal, onAccept }: { proposal: Offered; onAccept: () => Promise<void> }) {
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
        <button type="button" className="go" onClick={() => void onAccept()}>
          Accept
        </button>
      )}
    </div>
  );
}
