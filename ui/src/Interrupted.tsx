import { useEffect, useState } from 'react';

import type { Ticket } from '../../src/domain/ticket.ts';
import { wb } from './wb.ts';

/**
 * What the workbench was stopped in the middle of, over the board, the first time
 * you look at it after a restart.
 *
 * Nothing carries on by itself. Being stopped is usually deliberate — it is how an
 * update is picked up — so four agents starting again the moment a page loads
 * would be money spent on a decision nobody made. The board asks instead, with
 * everything checked, so saying yes to all of it costs one press.
 *
 * Dismissing it is this component's state and nowhere else's. The tickets stay
 * parked either way, so it comes back on the next load — which is right for work
 * nobody has decided about, and would be nagging for work anybody had.
 */
export function Interrupted(props: {
  /** The tickets stopped mid-stage. Never empty: nothing renders this when it is. */
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const { tickets, onAct, onClose } = props;
  const [picked, setPicked] = useState<string[]>(() => tickets.map((t) => t.id));

  // Escape closes it, the way it closes the list in Pick and the path in Repo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const carryOn = () => {
    onClose();
    void onAct(Promise.all(picked.map((id) => wb.carryOn(id))));
  };

  return (
    // Clicking away is the same as cancelling, and the box itself must not count
    // as clicking away — a checkbox is a click, and it lands here too.
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Stopped mid-stage"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Stopped mid-stage</h2>
        <div className="meta">
          The workbench stopped while {tickets.length === 1 ? 'this was' : 'these were'} running.
          Each still has the run it was in the middle of, so it can carry on from where it got to
          rather than pay for the whole stage again.
        </div>

        <ul>
          {tickets.map((t) => (
            <li key={t.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.includes(t.id)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked ? [...picked, t.id] : picked.filter((one) => one !== t.id),
                    )
                  }
                />
                <span className="mono">{t.id}</span>
                <span className="what">{t.title}</span>
                {/* What carrying on saves, and what starting again would cost
                    twice. The stage says which run it is; the figure says why
                    the question is worth asking at all. */}
                <span className="quiet">
                  {t.stage ?? 'not started'}
                  {t.costUsd > 0 && ` · $${t.costUsd.toFixed(2)} so far`}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="row">
          {/* Not disabled when nothing is ticked: unticking everything is a way of
              saying "none of these", and it should close the box like any other
              answer rather than leave you looking for the one button that works. */}
          <button type="button" className="go" onClick={carryOn}>
            Carry on selected
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
