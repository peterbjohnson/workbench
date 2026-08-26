import { useEffect, useRef, useState } from 'react';

import type { Ticket } from '../../src/domain/ticket.ts';
import { Pick } from './Pick.tsx';
import { wb } from './wb.ts';

/** How long the title has to stop changing before it is worth asking about. */
const SETTLED_MS = 800;

/**
 * Writing a ticket, and rewriting one. The same form both times: what you can say
 * when you create a ticket is exactly what you can change afterwards, so there is
 * no way to end up with a ticket you cannot fix.
 */
export function TicketForm(props: {
  title?: string;
  body?: string;
  /**
   * Offer the plan gate as a choice. Only when writing a ticket: the gate is a
   * fact about how this one is to be worked, settled when it is written, and a
   * ticket already past its plan cannot be given a gate it did not stop at.
   */
  askAboutApproval?: boolean;
  /**
   * Every ticket on the board, so a new one can say what it starts after. Offered
   * only when writing: this is the moment you know what the work follows, and
   * until now the only way to say it was to write the ticket and then go back
   * into it.
   */
  tickets?: Ticket[];
  submitLabel: string;
  onSubmit: (fields: {
    title: string;
    body: string;
    requiresApproval: boolean;
    waitsFor: string[];
  }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(props.title ?? '');
  const [body, setBody] = useState(props.body ?? '');
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [waitsFor, setWaitsFor] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  /** A better name for this ticket, and the name it is better than. */
  const [suggestion, setSuggestion] = useState<{ for: string; name: string; why: string }>();

  /**
   * Every name already asked about, so a name is asked about once however long
   * someone spends on the rest of the form — including one that came back with a
   * suggestion that was then dismissed, and the suggestion itself once taken.
   *
   * The name a ticket already has starts in it: opening the form to rewrite the
   * instructions is not someone asking what the ticket should be called.
   */
  const asked = useRef(new Set<string>([(props.title ?? '').trim()]));
  // Sent as context, but never what starts a question: typing the instructions
  // would otherwise keep pushing the one about the title further away.
  const bodyNow = useRef(body);
  bodyNow.current = body;
  // What is in the box now, so a slow answer about an earlier name cannot land on
  // top of the answer about this one. Two questions in flight is the ordinary
  // case: the wait is under a second and an answer takes several.
  const titleNow = useRef(title);
  titleNow.current = title;

  useEffect(() => {
    const name = title.trim();
    if (name === '' || asked.current.has(name)) return;

    const timer = setTimeout(() => {
      asked.current.add(name);
      void wb
        .checkName(name, bodyNow.current)
        .then((reply) => {
          if (name !== titleNow.current.trim()) return;
          if (reply.name !== null) {
            setSuggestion({ for: name, name: reply.name, why: reply.why ?? '' });
          }
        })
        // A hint about a name is never worth interrupting someone writing a ticket.
        .catch(() => {});
    }, SETTLED_MS);
    return () => clearTimeout(timer);
  }, [title]);

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() === '' || saving) return;
        setSaving(true);
        void props
          .onSubmit({ title: title.trim(), body, requiresApproval, waitsFor })
          .finally(() => setSaving(false));
      }}
    >
      <label>
        Title
        <input
          value={title}
          autoFocus
          placeholder="What you want done, in a few words"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      {/* Shown only while it is still about what is in the box: carry on typing and
          it goes, rather than recommending a name for a name you have left behind. */}
      {suggestion !== undefined && suggestion.for === title.trim() && (
        <div className="suggest">
          <span className="name">{suggestion.name}</span>
          <span className="quiet">{suggestion.why}</span>
          <button
            type="button"
            onClick={() => {
              asked.current.add(suggestion.name);
              setTitle(suggestion.name);
              setSuggestion(undefined);
            }}
          >
            Accept
          </button>
          <button type="button" onClick={() => setSuggestion(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <label>
        Instructions
        <textarea
          value={body}
          rows={12}
          placeholder={
            'Everything the work needs: what to do, what not to, what done looks like.\n\n' +
            'This goes to every stage, in full.'
          }
          onChange={(e) => setBody(e.target.value)}
        />
      </label>

      {props.tickets !== undefined && (
        <label>
          Start after
          <Pick id="after-new" picked={waitsFor} onChange={setWaitsFor} tickets={props.tickets} />
          <span className="quiet">
            Once you commit to it, it runs nothing until every one of these has offered its work or
            ended.
          </span>
        </label>
      )}

      {props.askAboutApproval === true && (
        <label className="switch">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => setRequiresApproval(e.target.checked)}
          />
          Plan requires your approval before implementation
          <span className="quiet">
            {requiresApproval
              ? 'It stops at the approval gate when the plan is written, and waits there for you.'
              : 'It builds what it plans, without stopping. The plan is still written, and still what review and verify hold it to.'}
          </span>
        </label>
      )}

      <div className="row">
        <button className="go" type="submit" disabled={title.trim() === '' || saving}>
          {props.submitLabel}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
