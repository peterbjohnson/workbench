import { useState } from 'react';

import type { Ticket } from '../../src/domain/ticket.ts';
import { joinTitle, splitTitle } from '../../src/domain/titles.ts';
import { Pick } from './Pick.tsx';

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
  /**
   * What the drop-down in front of the title offers, from the settings. It goes on
   * the front of the title itself, so with none configured there is no drop-down
   * and a title is just a title.
   */
  prefixes?: string[];
  submitLabel: string;
  /**
   * A second way to submit, which commits to the ticket as well as writing it.
   * Only when writing one: there is nothing to commit to when rewriting.
   */
  commitLabel?: string;
  onSubmit: (fields: {
    title: string;
    body: string;
    requiresApproval: boolean;
    waitsFor: string[];
    commit: boolean;
  }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const prefixes = props.prefixes ?? [];
  // A ticket being rewritten arrives with its prefix in its title, so it comes
  // apart into the two boxes it was written in and goes back together the same.
  const written = splitTitle(props.title ?? '', prefixes);
  const [prefix, setPrefix] = useState(written.prefix);
  const [title, setTitle] = useState(written.rest);
  const [body, setBody] = useState(props.body ?? '');
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [waitsFor, setWaitsFor] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = (commit: boolean) => {
    if (title.trim() === '' || saving) return;
    setSaving(true);
    void props
      .onSubmit({ title: joinTitle(prefix, title), body, requiresApproval, waitsFor, commit })
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        // Enter submits the plain one: the safe half of the pair, when there is a pair.
        submit(false);
      }}
    >
      <label>
        Title
        <div className="titled">
          {prefixes.length > 0 && (
            <select value={prefix} onChange={(e) => setPrefix(e.target.value)}>
              <option value="">none</option>
              {prefixes.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          )}
          <input
            value={title}
            autoFocus
            placeholder="What you want done, in a few words"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      </label>

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
        <button
          className={props.commitLabel === undefined ? 'go' : ''}
          type="submit"
          disabled={title.trim() === '' || saving}
        >
          {props.submitLabel}
        </button>
        {props.commitLabel !== undefined && (
          <button
            className="go"
            type="button"
            disabled={title.trim() === '' || saving}
            onClick={() => submit(true)}
          >
            {props.commitLabel}
          </button>
        )}
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
