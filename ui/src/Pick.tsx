import { useState } from 'react';

import { released } from '../../src/domain/rules.ts';
import { ended, type Ticket } from '../../src/domain/ticket.ts';

/**
 * Choosing tickets, by filtering the board rather than typing ids. A ticket id is
 * not something anyone remembers, and a free-text box takes an id that does not
 * exist as readily as one that does.
 *
 * It holds only what is being typed. The selection belongs to whoever is asking —
 * the panel, which sends it when you press Update, and the new-ticket form, which
 * sends it along with everything else — so this cannot get out of step with what
 * is about to be saved.
 */
export function Pick(props: {
  /** For the label, and unique on the page when two of these are open at once. */
  id: string;
  picked: string[];
  onChange: (picked: string[]) => void;
  /** Every ticket on the board. What may be chosen is worked out from it. */
  tickets: Ticket[];
  /** The ticket doing the waiting, when it exists. It may not wait for itself. */
  self?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const { picked, onChange } = props;

  /**
   * Only tickets that would actually hold this one back. One that has offered its
   * work or ended releases the moment it is chosen, so listing it would be
   * offering something that does nothing.
   */
  const choices = props.tickets.filter(
    (o) => o.id !== props.self && !released(o) && !ended(o) && !picked.includes(o.id),
  );
  const needle = query.trim().toLowerCase();
  const matching = choices.filter((o) => `${o.id} ${o.title}`.toLowerCase().includes(needle));

  const add = (id: string) => {
    onChange([...picked, id]);
    setQuery('');
  };

  return (
    <div
      className="pick"
      // Closing on blur has to ignore focus moving inside the control, or clicking
      // an option would shut the list before the click landed.
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <div className="chosen">
        {picked.map((id) => (
          <span key={id} className="chip">
            {id}
            <button
              type="button"
              aria-label={`stop waiting for ${id}`}
              onClick={() => onChange(picked.filter((one) => one !== id))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={props.id}
          value={query}
          placeholder={picked.length === 0 ? 'type to find a ticket…' : ''}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            // Enter takes the first match rather than submitting a half-typed
            // filter; backspace on an empty box takes the last one off again.
            if (e.key === 'Enter' && matching[0] !== undefined) {
              e.preventDefault();
              add(matching[0].id);
            }
            if (e.key === 'Backspace' && query === '') onChange(picked.slice(0, -1));
            if (e.key === 'Escape') setOpen(false);
          }}
        />
      </div>

      {/* Open whenever the box has the cursor, and say so when there is nothing to
          show. Rendering nothing at all is indistinguishable from a control that
          does not work — which is how it read on a board whose tickets had every
          one of them been offered or finished, so there was genuinely nothing left
          that could hold anything up. */}
      {open && (
        <ul className="options">
          {matching.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => add(o.id)}>
                <span className="mono">{o.id}</span> {o.title}
              </button>
            </li>
          ))}
          {matching.length === 0 && (
            <li className="none">
              {choices.length === 0
                ? 'nothing left to wait for — every other ticket has offered its work or ended'
                : `no ticket matches “${query.trim()}”`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
