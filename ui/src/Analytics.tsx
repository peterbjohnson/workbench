import { useEffect, useState, type ReactNode } from 'react';

import type { Analytics as Stats, Slice } from '../../src/domain/analytics.ts';
import { wb } from './wb.ts';

/**
 * What the board has done, in numbers. Every one of them is worked out on the
 * server from the event log — nothing here is stored, and nothing here is counted
 * in the browser, so this page fetches an answer and draws it.
 *
 * Drawn by hand in SVG and CSS rather than by a charting library: the front end
 * has React and nothing else, and two bar shapes are not worth a dependency.
 */
export function Analytics({ version }: { version: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read on the same bump the board redraws off, so a stage finishing moves
  // these numbers without a refresh button and without polling.
  useEffect(() => {
    let live = true;
    wb.analytics()
      .then((a) => {
        // Clear the error as well as setting the numbers: a fetch that failed once
        // would otherwise leave the page showing that failure for ever, however
        // many later reads succeed.
        if (!live) return;
        setStats(a);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [version]);

  if (error !== null) return <div className="error">{error}</div>;
  if (stats === null) return <div className="empty">Reading…</div>;

  const { headline, money, flow, agents } = stats;

  if (headline.tickets === 0) {
    return (
      <div className="empty">Nothing has happened yet. Everything here is read off the log.</div>
    );
  }

  return (
    <div className="page analytics">
      <section>
        <h2>The board</h2>
        <div className="stats">
          <Stat label="Tickets" value={String(headline.tickets)} />
          <Stat label="Merged" value={String(headline.accepted)} />
          <Stat label="Cancelled" value={String(headline.cancelled)} />
          <Stat label="Given up on" value={String(headline.gaveUp)} />
          <Stat
            label="Accepted"
            value={percent(headline.acceptanceRate)}
            note="of the tickets that ended"
          />
          <Stat label="Spent" value={usd(headline.totalUsd)} note="stages only" />
          <Stat label="Chat" value={usd(headline.chatUsd)} note="never charged to a ticket" />
          <Stat
            label="A merged ticket"
            value={usd(headline.medianAcceptedUsd)}
            note={`median — the mean is ${usd(headline.meanAcceptedUsd)}`}
          />
        </div>
        <h3>Where everything is</h3>
        <Bars items={headline.byColumn} />
      </section>

      <section>
        <h2>Money</h2>
        <div className="two">
          <div>
            <h3>By stage</h3>
            <Bars items={money.byStage} format={usd} />
          </div>
          <div>
            <h3>By scale</h3>
            <Bars items={money.byScale} format={usd} />
          </div>
        </div>
        <h3>What a ticket costs</h3>
        <Bars items={money.histogram} />
        <h3>The most expensive</h3>
        {money.dearest.length === 0 ? (
          <p className="quiet">Nothing has cost anything yet.</p>
        ) : (
          <table>
            <tbody>
              {money.dearest.map((t) => (
                <tr key={t.id}>
                  <td className="mono">
                    <a href={`#${t.id}`}>{t.id}</a>
                  </td>
                  <td>{t.title}</td>
                  <td className="num">{usd(t.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {headline.dearest !== null && (
          <p className="quiet">
            The dearest single ticket is {headline.dearest.id} at {usd(headline.dearest.costUsd)}.
          </p>
        )}
      </section>

      <section>
        <h2>Flow</h2>
        <h3>Tickets finished per week</h3>
        {flow.perWeek.length === 0 ? (
          <p className="quiet">Nothing has finished yet.</p>
        ) : (
          <Columns items={flow.perWeek} />
        )}
        <div className="stats">
          <Stat
            label="Lead time"
            value={duration(flow.medianLeadMs)}
            note="median, committed to merged"
          />
          <Stat
            label="Build time"
            value={duration(flow.medianBuildMs)}
            note="median, first stage to merged"
          />
          <Stat label="Plans approved" value={String(flow.approvals)} />
          <Stat label="Plans sent back" value={String(flow.rejections)} />
          <Stat label="Cycles" value={round(flow.meanCycles)} note="mean, per merged ticket" />
          <Stat
            label="Revisions"
            value={round(flow.meanRevisions)}
            note="mean, per merged ticket"
          />
          <Stat label="Commits" value={round(flow.meanCommits)} note="mean, per merged ticket" />
        </div>
      </section>

      <section>
        <h2>Agents</h2>
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th className="num">Runs</th>
              <th className="num">Median</th>
              <th className="num">Mean cost</th>
              <th>How they ended</th>
            </tr>
          </thead>
          <tbody>
            {agents.stages.map((s) => (
              <tr key={s.stage}>
                <td>{s.stage}</td>
                <td className="num">{s.runs}</td>
                <td className="num">{duration(s.medianMs)}</td>
                <td className="num">{usd(s.meanUsd)}</td>
                <td className="quiet">
                  {s.outcomes.length === 0
                    ? '—'
                    : s.outcomes.map((o) => `${o.label} ×${o.value}`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="stats">
          <Stat label="Tool calls" value={String(agents.toolCalls)} />
          <Stat label="Refused" value={String(agents.refused)} note="by the guard" />
          <Stat label="Checks passed" value={String(agents.checks.passed)} />
          <Stat label="Checks failed" value={String(agents.checks.failed)} />
        </div>

        <div className="two">
          <div>
            <h3>Tools</h3>
            <Bars items={agents.tools} />
          </div>
          <div>
            <h3>Questions asked</h3>
            <Bars items={agents.questions} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** One number, said large, with what it is under it. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
      {note !== undefined && <span className="quiet">{note}</span>}
    </div>
  );
}

/** A labelled row per thing, each drawn as far along as its share of the largest. */
function Bars({ items, format }: { items: Slice[]; format?: (n: number) => string }): ReactNode {
  const most = Math.max(...items.map((i) => i.value), 0);
  if (items.length === 0) return <p className="quiet">Nothing yet.</p>;

  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar" key={i.label}>
          <span className="label">{i.label}</span>
          <span className="track">
            <span
              className="fill"
              style={{ width: most === 0 ? 0 : `${(i.value / most) * 100}%` }}
            />
          </span>
          <span className="num">{format === undefined ? i.value : format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** How wide a week is drawn, and how tall the tallest column, in the chart's own units. */
const WEEK = 44;
const TALL = 90;

/** A column per week, labelled underneath, scaled to whichever week was busiest. */
function Columns({ items }: { items: Slice[] }) {
  const most = Math.max(...items.map((i) => i.value), 1);
  const width = items.length * WEEK;

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${TALL + 30}`}
      role="img"
      aria-label="Tickets finished per week"
    >
      {items.map((i, n) => {
        const high = (i.value / most) * TALL;
        return (
          <g key={i.label}>
            <rect x={n * WEEK + 6} y={TALL - high} width={WEEK - 12} height={high} rx="2" />
            {i.value > 0 && (
              <text className="value" x={n * WEEK + WEEK / 2} y={TALL - high - 4}>
                {i.value}
              </text>
            )}
            <text className="week" x={n * WEEK + WEEK / 2} y={TALL + 14}>
              {i.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const percent = (n: number) => `${Math.round(n * 100)}%`;
const round = (n: number) => n.toFixed(1);

/** A span in the largest unit it reads well in. Em dash for one there is no median of. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / (60 * 24)).toFixed(1)}d`;
}
