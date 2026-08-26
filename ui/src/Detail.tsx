import { useEffect, useRef, useState } from 'react';

import {
  details,
  madeInto,
  runs,
  salvageable,
  sendableBack,
  statusOf,
  suggestion,
  toneOf,
  type Run,
} from '../../src/domain/board.ts';
import type { Event } from '../../src/domain/events.ts';
import { ended, type Ticket } from '../../src/domain/ticket.ts';
import { Pick } from './Pick.tsx';
import { TicketForm } from './TicketForm.tsx';
import { wb } from './wb.ts';

export function Detail(props: {
  id: string;
  version: number;
  /** Every ticket on the board, which is where a suggestion's fate is written. */
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const { id, version, tickets, onAct, onClose } = props;
  const [state, setState] = useState<{ ticket: Ticket; events: Event[] } | null>(null);
  const [editing, setEditing] = useState(false);
  /**
   * Whether the description is open, once you have said. Null until you do, and
   * then the default decides: a ticket that has not started is only its
   * description, and one that has is opened to find out where it got to.
   *
   * Held here rather than left to the `<details>` because this panel re-renders on
   * every event — an uncontrolled one would snap back to the default mid-read.
   */
  const [showBody, setShowBody] = useState<boolean | null>(null);

  // A different ticket is a different ticket, not the one you were editing.
  useEffect(() => setEditing(false), [id]);
  useEffect(() => setShowBody(null), [id]);

  useEffect(() => {
    let live = true;
    wb.ticket(id)
      .then((r) => live && setState(r))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [id, version]);

  if (state === null) return null;
  const { ticket: t, events } = state;
  const stages = runs(events);
  const lastPlan = stages.reduce((at, run, i) => (run.stage === 'plan' ? i : at), -1);

  return (
    <aside>
      <button type="button" className="close" onClick={onClose}>
        Close
      </button>

      <h2>{t.title}</h2>
      <div className="meta">
        <span className="mono">{t.id}</span> · {t.status.replace(/_/g, ' ')}
        {t.running && ' · running'}
        {/* Otherwise a ticket that never stops to be approved looks like one whose
            gate you missed. Said only when it is true; the gate is the default. */}
        {!t.requiresApproval && ' · builds its plan unapproved'}
        {t.plan !== null && ` · ${t.scale}`}
        {t.costUsd > 0 && ` · $${t.costUsd.toFixed(2)}`}
        {t.cycles > 1 && ` · round ${t.cycles}`}
        {t.continues !== null && (
          <>
            {' · from '}
            <a href={`#${t.continues}`}>{t.continues}</a>
          </>
        )}
        {t.waitsFor.map((id) => (
          <span key={id}>
            {' · waits for '}
            <a href={`#${id}`}>{id}</a>
          </span>
        ))}
        {t.prUrl !== null && (
          <>
            {' · '}
            <a href={t.prUrl} target="_blank" rel="noreferrer">
              pull request
            </a>
          </>
        )}
      </div>

      {/* Where it has got to, in one line. The blocks per stage are further down
          for when you want them; this is the answer to "what is happening", which
          is what the panel is opened for. */}
      {stages.length > 0 && <Pipeline stages={stages} step={t.step} steps={t.steps} />}

      {t.question !== null && (
        <div className="box ask">
          <h3>Waiting on you</h3>
          {t.question.question}
          <div className="meta why">{t.question.reasoning}</div>
        </div>
      )}

      {t.rejection !== null && (
        <div className="box">
          <h3>Sent back because</h3>
          {t.rejection}
        </div>
      )}

      {t.changes !== null && (
        <div className="box">
          {/* Only when a round of agent comments is what put it there. Yours count
              none, so the heading would otherwise say "revision 0". */}
          <h3>Changes asked for{t.revisions > 0 && ` — revision ${t.revisions}`}</h3>
          {t.changes}
        </div>
      )}

      <Actions ticket={t} tickets={tickets} onAct={onAct} />

      {/* What the work was asked for, above what has been made of it: the plan and
          the runs are answers to this, and reading them against anything else is
          how a ticket gets judged for something it never asked for. Folded, because
          it is the longest thing here. */}
      <details
        open={showBody ?? stages.length === 0}
        onToggle={(e) => setShowBody(e.currentTarget.open)}
      >
        <summary>Description</summary>
        {editing ? (
          <TicketForm
            title={t.title}
            body={t.body}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            // Title and body only. The gate was settled when the ticket was written,
            // and the form does not offer it here.
            onSubmit={({ title, body }) =>
              onAct(wb.edit(t.id, { title, body })).then(() => setEditing(false))
            }
          />
        ) : (
          <>
            {t.body === '' ? (
              <div className="box quiet">No instructions yet.</div>
            ) : (
              <div className="box">{t.body}</div>
            )}
            <div className="row">
              <button type="button" onClick={() => setEditing(true)}>
                Edit ticket
              </button>
              {t.running && (
                <span className="quiet">
                  a stage is running, and keeps the wording it was given
                </span>
              )}
            </div>
          </>
        )}
      </details>

      {/* Omitted rather than shown empty: a heading with nothing under it says a
          stage produced nothing, when in fact none has run. */}
      {stages.length > 0 && (
        <section>
          <h3>Progress</h3>
          {stages.map((run, i) => (
            <RunBlock
              key={i}
              run={run}
              // The finish line and the steps in force belong to the plan run that
              // wrote them — which is the last one, after a ticket has been round
              // again. An earlier plan says only what it said at the time.
              plan={i === lastPlan ? { doneWhen: t.doneWhen, steps: t.steps } : null}
              // The checklist belongs to the run that is working through it.
              steps={run.outcome === 'running' ? t.steps : []}
              reached={run.outcome === 'running' ? t.step : null}
              onAct={onAct}
              ticket={t}
              tickets={tickets}
            />
          ))}
        </section>
      )}

      <Git ticket={t} />

      <details>
        <summary>Everything that happened ({events.length})</summary>
        <div className="log">
          {events.map((e) => (
            <LogLine key={e.id} event={e} />
          ))}
        </div>
      </details>
    </aside>
  );
}

/**
 * One stage run, in three depths. What a stage produced is usually pages — a whole
 * plan, a whole review — and reading a ticket should not mean scrolling through all
 * of it every time. The status and the numbers stay on the line; opening it says
 * what the stage made of the ticket in a few lines; opening that says everything.
 *
 * The middle depth is the whole point. Every stage had one place to be read and it
 * was the pages, so the pages were skipped and the stage said nothing at all.
 */
function RunBlock({
  run,
  plan,
  steps,
  reached,
  ticket,
  tickets,
  onAct,
}: {
  run: Run;
  /** The finish line and the steps this run set, when it is the plan in force. */
  plan: { doneWhen: string[]; steps: string[] } | null;
  steps: string[];
  reached: number | null;
  ticket: Ticket;
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
}) {
  const status = statusOf(run);
  const tone = toneOf(run);

  // Everything this run said, in the order it is worth reading. A verdict is as
  // long as a summary — the objections that come back from a review run to pages —
  // so each part is cut to its opening, and the fold below holds all of them whole.
  const said: [label: string, text: string][] = (
    [
      ['', run.summary],
      ['asked', run.question],
      ['did not approve', run.rejected],
      ['asked for changes', run.changes],
    ] as [string, string | null][]
  )
    .map(([label, text]): [string, string] => [label, (text ?? '').trim()])
    .filter(([, text]) => text !== '');
  const gist = said.map(([label, text]): [string, string] => [label, opening(text)]);
  const cut = said.some(([, text], i) => text !== gist[i]?.[1]);

  const notes = [
    run.checks && `checks: ${run.checks.passed} passed, ${run.checks.failed} failed`,
    run.toolCalls > 0 && `${run.toolCalls} tool call${run.toolCalls === 1 ? '' : 's'}`,
    run.refused.length > 0 && `refused: ${run.refused.join(', ')}`,
    run.costUsd > 0 && `$${run.costUsd.toFixed(2)}`,
  ].filter((n): n is string => typeof n === 'string');

  const detail = said.length > 0 || plan !== null;

  const head = (
    <div className="head">
      <span className="stage">{run.stage}</span>
      <span className={`status ${tone}`}>{status}</span>
      <span className="quiet">
        {notes.join(' · ')}
        {notes.length > 0 && ' · '}
        {run.at.slice(11, 16)}
      </span>
    </div>
  );

  return (
    <div
      className={`run${run.outcome === 'running' ? ' running' : ''}${tone === 'bad' ? ' bad' : ''}`}
    >
      {detail ? (
        <details>
          <summary>{head}</summary>
          {/* What the plan settled is its gist: the finish line review judges
              against, and the steps the work breaks into. */}
          {plan !== null && plan.doneWhen.length > 0 && (
            <>
              <h4>Done when</h4>
              <ul className="done-when">
                {plan.doneWhen.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </>
          )}
          {plan !== null && plan.steps.length > 0 && <Steps steps={plan.steps} reached={null} />}
          {gist.map(([label, text]) => (
            <p key={label}>
              {label !== '' && `${label}: `}
              {text}
            </p>
          ))}
          {cut && (
            <details className="prose">
              <summary>All of it</summary>
              {said.map(([label, text]) => (
                <p key={label}>
                  {label !== '' && `${label}: `}
                  {text}
                </p>
              ))}
            </details>
          )}
        </details>
      ) : (
        head
      )}
      {steps.length > 0 && <Steps steps={steps} reached={reached} />}
      {run.later.length > 0 && <Later run={run} ticket={ticket} tickets={tickets} onAct={onAct} />}
    </div>
  );
}

/**
 * What a stage wrote, in short: its first paragraph of prose. A stage writes pages,
 * and the opening is nearly always what it did — the rest is the working, which is
 * what the second fold is for.
 *
 * A leading `# Plan for t17` is a title rather than a thing that happened, so
 * headings are passed over to the first paragraph that says something.
 */
function opening(said: string): string {
  const first =
    said
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p !== '' && !/^#{1,6}\s/.test(p)) ?? '';
  return first.length > 300 ? `${first.slice(0, 300).replace(/\s+\S*$/, '')}…` : first;
}

/**
 * What this stage thought worth doing that was not this ticket's job. One click
 * keeps it, and ignoring it costs nothing — which is the point: a reviewer with
 * somewhere to put a good idea does not have to put it in the verdict.
 *
 * Folded, and saying how many are in there. A stage that noticed six things is six
 * paragraphs between the run that noticed them and the next run, none of which is
 * what the panel was opened to find out.
 */
function Later({
  run,
  ticket,
  tickets,
  onAct,
}: {
  run: Run;
  ticket: Ticket;
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
}) {
  return (
    <details className="later">
      <summary>Worth a ticket later ({run.later.length})</summary>
      {run.later.map((idea) => {
        // An idea that is already a ticket says which one and links to it. The
        // buttons went on offering to make it again, and clicking twice made two.
        const made = madeInto(tickets, ticket, run.stage, idea);
        const { title, what, body } = suggestion(ticket, run.stage, idea);

        return (
          <div className="row" key={idea}>
            <div className="idea">
              <b>{title}</b>
              {what !== '' && ` ${what}`}
            </div>
            {made ? (
              <a className="made" href={`#${made.id}`}>
                {made.status === 'backlog' ? 'Backlogged' : 'Committed'} as {made.id}
              </a>
            ) : (
              <div className="pair">
                <button type="button" onClick={() => void onAct(wb.create(title, body))}>
                  Backlog
                </button>
                <button
                  type="button"
                  className="go"
                  onClick={() =>
                    void onAct(wb.create(title, body).then((made) => wb.queue(made.id)))
                  }
                >
                  Commit to it
                </button>
              </div>
            )}
          </div>
        );
      })}
    </details>
  );
}

/**
 * The approved steps, and how far the stage says it has got. This is the answer to
 * a stage that runs for twenty minutes saying only "running".
 */
function Steps({ steps, reached }: { steps: string[]; reached: number | null }) {
  return (
    <ol className="steps">
      {steps.map((step, i) => {
        const n = i + 1;
        const state = reached === null ? '' : n < reached ? 'past' : n === reached ? 'now' : '';
        return (
          <li key={step} className={state}>
            {step}
          </li>
        );
      })}
    </ol>
  );
}

/** Where the work is, for anyone who wants to go and look at it. */
function Git({ ticket: t }: { ticket: Ticket }) {
  return (
    <details>
      <summary>Git</summary>
      <dl className="git">
        <dt>branch</dt>
        <dd className="mono">{t.branch}</dd>
        {t.continues !== null && (
          <>
            <dt>continues</dt>
            <dd className="mono">{t.continues}</dd>
          </>
        )}
        {t.base !== null && (
          <>
            <dt>base</dt>
            <dd className="mono">{t.base.slice(0, 8)}</dd>
          </>
        )}
        {t.commits.length > 0 && (
          <>
            <dt>commits</dt>
            <dd className="mono">{t.commits.map((c) => c.slice(0, 8)).join(' ')}</dd>
          </>
        )}
        {/* The pull request is not here: it is at the top, where what to do about
            it is. This is where the work is, for going and looking at it. */}
      </dl>
    </details>
  );
}

function Actions({
  ticket: t,
  tickets,
  onAct,
}: {
  ticket: Ticket;
  /** The whole board: what "start after" is chosen from. */
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
}) {
  return (
    <>
      {t.status === 'backlog' && (
        <div className="row">
          <button type="button" className="go" onClick={() => void onAct(wb.queue(t.id))}>
            Commit to it
          </button>
        </div>
      )}

      {t.status === 'queued' && (
        <div className="row">
          <button type="button" onClick={() => void onAct(wb.backlog(t.id))}>
            Back to the backlog
          </button>
        </div>
      )}

      {t.status === 'plan_gate' && (
        <div className="row">
          <button type="button" className="go" onClick={() => void onAct(wb.approve(t.id))}>
            Approve plan
          </button>
        </div>
      )}

      {t.status === 'blocked' && (
        <>
          {/* Stopped rather than broken, so the run it was in the middle of is
              still there. Restarting stays beside it, unstyled: carrying on is
              the cheap answer and usually the right one, but sometimes it is not,
              and then somebody has to be able to say so. */}
          {t.interrupted && (
            <div className="row">
              <button type="button" className="go" onClick={() => void onAct(wb.carryOn(t.id))}>
                Carry on where it stopped
              </button>
              <button type="button" onClick={() => void onAct(wb.restart(t.id))}>
                Start this stage again
              </button>
            </div>
          )}
          {/* A stage that failed asked nothing, so there is nothing to answer:
              what it needs is to be run again. */}
          {!t.interrupted && t.question === null && (
            <div className="row">
              <button type="button" className="go" onClick={() => void onAct(wb.restart(t.id))}>
                Restart this stage
              </button>
            </div>
          )}
          {t.question !== null && (
            <div className="row">
              <button type="button" onClick={() => void onAct(wb.restart(t.id))}>
                Restart instead
              </button>
            </div>
          )}
        </>
      )}

      {/* The manager's own verdict. Anything with work in it can be offered as a
          pull request, whatever the agents made of it — otherwise two of them
          disagreeing is the end of a ticket, which is how every real one has died. */}
      {t.commits.length > 0 && !t.running && !t.offered && t.status !== 'done' && (
        <div className="row">
          <button type="button" className="go" onClick={() => void onAct(wb.ship(t.id))}>
            Ship it
          </button>
          <span className="quiet">offer what it has as a pull request, and decide there</span>
        </div>
      )}

      {/* The card says how many commits are here to salvage; this is where that is
          acted on. The address is the router, so writing the new ticket is a place
          you can be linked to and reload into, same as reading this one. */}
      {salvageable(t) && (
        <div className="row">
          <button type="button" className="go" onClick={() => (location.hash = `new:${t.id}`)}>
            Carry on from this
          </button>
          <span className="quiet">a new ticket, starting on this branch rather than main</span>
        </div>
      )}

      {/* Everything that needs something typed or picked, as one grid: what it is,
          what you say, and the button. Three columns down the whole block, so the
          buttons line up and read as the same kind of thing rather than as a row of
          differently-sized decisions. */}
      <div className="acts">
        {t.question !== null && (
          <Act
            title="Answer it:"
            placeholder="what the agent asked for…"
            label="Go"
            go
            onSay={(answer) => onAct(wb.answer(t.id, answer))}
          />
        )}

        {/* Sequencing, for the ticket that must not run before others. Offered
            while the ticket can still run, and while it is held — a condition you
            cannot take back off is a way to lose a ticket. */}
        {!ended(t) && <StartAfter ticket={t} tickets={tickets} onAct={onAct} />}

        {/* "Keep the work and put this right" needs work to keep, so this one waits
            for a commit. At the plan gate there is none, and the choice there stays
            what it has always been: approve the plan, or send it back. */}
        {sendableBack(t) && t.commits.length > 0 && (
          <Act
            title="Ask for changes:"
            placeholder="what to put right, keeping the work…"
            label="Send back"
            onSay={(changes) => onAct(wb.changes(t.id, changes))}
          />
        )}

        {/* The expensive no, wherever there is something to say it about. It was
            offered at the plan gate and nowhere else, so work you had already been
            offered could only be sent back through GitHub. */}
        {sendableBack(t) && (
          <Act
            title="Replan it:"
            placeholder="why the approach is wrong…"
            label="Send back"
            onSay={(reason) => onAct(wb.reject(t.id, reason))}
          />
        )}

        {/* Stopping a ticket is never what it is waiting for, but it is a thing you
            do to a ticket — so it belongs with the rest of them rather than at the
            far end of the panel past everything the ticket has produced. Anything
            that has not ended can be stopped, an idea still in the backlog
            included: that is how one you decided against leaves the board. */}
        {!ended(t) && (
          <Act
            title="Reject/cancel it:"
            placeholder="why you are stopping it…"
            label="Cancel"
            allowEmpty
            onSay={(reason) => onAct(wb.cancel(t.id, reason))}
          />
        )}
      </div>
    </>
  );
}

/**
 * One row of the action grid: what it is, what you say, and the button that sends
 * it. `display: contents` on the form, so the three land in the parent's columns
 * and every button in the block is the same width and in the same place.
 */
function Act(props: {
  title: string;
  placeholder: string;
  label: string;
  go?: boolean;
  allowEmpty?: boolean;
  onSay: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const field = props.title.toLowerCase().replace(/[^a-z]+/g, '-');
  const box = useRef<HTMLTextAreaElement>(null);

  /* What you say to a ticket is usually a paragraph, not a line, so the box is as
     tall as what is in it — starting at one line and growing as you type, rather
     than scrolling the beginning of the thought out of sight. */
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    // An empty one is left to its single row: measuring it would size the box to
    // the wrapped placeholder, which is two lines of nothing.
    el.style.height = 'auto';
    if (text !== '') el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <form
      className="act"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() === '' && props.allowEmpty !== true) return;
        void props.onSay(text.trim()).then(() => setText(''));
      }}
    >
      <label htmlFor={field}>{props.title}</label>
      <textarea
        id={field}
        ref={box}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        /* Enter still sends, as it did when this was one line; a newline is
           shift-enter. */
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button type="submit" className={props.go === true ? 'go' : undefined}>
        {props.label}
      </button>
    </form>
  );
}

/**
 * Which tickets this one starts after. Picked from the board rather than typed:
 * a ticket id is not something anyone remembers, and a free-text box accepts
 * every id that does not exist as readily as the one that does.
 *
 * Only tickets that would actually hold this one back are offered. One that has
 * already offered its work or ended releases the moment it is chosen, so putting
 * it in the list would be picking something that does nothing.
 */
function StartAfter({
  ticket: t,
  tickets,
  onAct,
}: {
  ticket: Ticket;
  tickets: Ticket[];
  onAct: (work: Promise<unknown>) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string[]>(t.waitsFor);

  // The panel redraws on every event; a selection being edited must not be
  // replaced under the cursor, but moving to another ticket must reset it.
  useEffect(() => setPicked(t.waitsFor), [t.id, t.waitsFor.join(',')]);

  return (
    <form
      className="act"
      onSubmit={(e) => {
        e.preventDefault();
        void onAct(wb.wait(t.id, picked));
      }}
    >
      <label htmlFor={`after-${t.id}`}>Start after:</label>
      <Pick
        id={`after-${t.id}`}
        picked={picked}
        onChange={setPicked}
        tickets={tickets}
        self={t.id}
      />
      <button type="submit">Update</button>
    </form>
  );
}

/**
 * Where the ticket has got to, as one line of stages. The blocks below say what
 * each run did and cost; this says only which of them there were and how each
 * ended, which is the question the panel is opened with.
 */
function Pipeline({
  stages,
  step,
  steps,
}: {
  stages: Run[];
  step: number | null;
  steps: string[];
}) {
  return (
    <div className="pipeline">
      {stages.map((run, i) => {
        const tone = toneOf(run);
        // A running stage says how far it has got, when it has said. "running"
        // on its own is the one thing you already knew from the card.
        const said =
          run.outcome === 'running' && step !== null && steps.length > 0
            ? `step ${step}/${steps.length}`
            : statusOf(run);

        return (
          <span key={i}>
            <span className="stage">{run.stage}</span>{' '}
            <span className={`status ${tone}`}>{said}</span>
          </span>
        );
      })}
    </div>
  );
}

/** A line of text and the button that sends it. Every action here needs one. */
function Say(props: {
  placeholder: string;
  label: string;
  go?: boolean;
  allowEmpty?: boolean;
  onSay: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');

  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() === '' && props.allowEmpty !== true) return;
        void props.onSay(text.trim()).then(() => setText(''));
      }}
    >
      <input
        value={text}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className={props.go === true ? 'go' : undefined}>
        {props.label}
      </button>
    </form>
  );
}

/**
 * One line of the log, which opens on to everything it is not saying. Most of what
 * an agent did is in these events and none of it fits on a line — a plan run writes
 * thousands of words, and a tool call carries the arguments it was really given.
 */
function LogLine({ event }: { event: Event }) {
  const shown = detail(event);
  const line = (
    <>
      {event.at.slice(11, 19)} <b>{event.type}</b> {shown}
    </>
  );

  const more = details(event, shown);
  // No disclosure triangle on a line that is already the whole event.
  if (more.length === 0) return <div>{line}</div>;

  return (
    <details>
      <summary>{line}</summary>
      {more.map(([field, value]) => (
        <div className="field" key={field}>
          <span>{field}</span>
          <div>{value}</div>
        </div>
      ))}
    </details>
  );
}

/** The one telling field of each event type, for the raw log. */
function detail(e: Event): string {
  switch (e.type) {
    case 'agent_said':
      return first(e.text);
    case 'ticket_created':
    case 'ticket_edited':
      return first(e.title ?? '');
    case 'stage_started':
      return e.stage;
    case 'stage_finished':
      return e.outcome;
    case 'tool_requested':
      return `${e.tool}${e.allowed ? '' : ' — REFUSED'}`;
    case 'checks_run':
      return `${e.results.length} check(s), ${e.results.filter((r) => !r.ok).length} failed`;
    case 'question_asked':
      return e.question;
    case 'question_answered':
      return e.answer;
    case 'blocked':
    case 'cancelled':
    case 'gave_up':
    case 'plan_rejected':
      return e.reason;
    case 'changes_requested':
      return first(e.changes);
    case 'pr_opened':
      return e.url;
    case 'verdict':
      return e.verdict;
    case 'branched':
      return e.branch;
    case 'refreshed':
      return `merged the base at ${e.base.slice(0, 8)}`;
    default:
      return '';
  }
}

/** Enough of what an agent said to tell one line from the next. The rest opens. */
function first(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
