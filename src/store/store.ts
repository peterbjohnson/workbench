import { DatabaseSync } from 'node:sqlite';

import type { Event, EventBody } from '../domain/events.ts';
import { deriveTicket, type Ticket } from '../domain/ticket.ts';
import { ordered } from '../domain/board.ts';
import { DEFAULT_POLICY, POLICY_KEYS, type Policy } from '../domain/rules.ts';

/**
 * Events are appended and never updated or deleted. Tickets are derived on read.
 * If that ever gets slow, cache derived tickets — not before.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    at        TEXT NOT NULL,
    body      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_ticket ON events (ticket_id, id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export type Store = {
  append(ticketId: string, body: EventBody): Event;
  eventsFor(ticketId: string): Event[];
  ticket(ticketId: string): Ticket;
  ticketIds(): string[];
  tickets(): Ticket[];
  /** Total events ever appended. Lets a caller tell whether anything actually happened. */
  eventCount(): number;
  policy(): Policy;
  /** Change some of the limits, leaving the rest. Returns the whole policy after. */
  setPolicy(patch: Partial<Policy>): Policy;
  /**
   * Whether the whole workbench is stopped. Kept in the database rather than in
   * memory because stopping to update the workbench means restarting it, and a
   * stop that forgot itself over the restart would be no stop at all.
   */
  stopped(): boolean;
  setStopped(on: boolean): void;
  /** Called after each append, in process. Returns an unsubscribe function. */
  subscribe(fn: (e: Event) => void): () => void;
  close(): void;
};

type Row = { id: number; ticket_id: string; at: string; body: string };

/** The settings key the whole-workbench stop lives under. Not a policy limit. */
const STOPPED = 'stopped';

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const insert = db.prepare('INSERT INTO events (ticket_id, at, body) VALUES (?, ?, ?)');
  const selectForTicket = db.prepare(
    'SELECT id, ticket_id, at, body FROM events WHERE ticket_id = ? ORDER BY id',
  );
  // Creation order, not id order. Ids sort as text, so `t10` came before `t2` and
  // "take from the top of the queue" quietly meant something else.
  const selectIds = db.prepare('SELECT ticket_id FROM events GROUP BY ticket_id ORDER BY MIN(id)');
  // Every move ever made, oldest first, which is how they are replayed. The one
  // query in here that reads across tickets: where a ticket sits is a fact about
  // the board, and no ticket's own events can answer it.
  const selectMoves = db.prepare(
    `SELECT ticket_id, json_extract(body, '$.before') AS before FROM events
     WHERE json_extract(body, '$.type') = 'moved' ORDER BY id`,
  );
  const countEvents = db.prepare('SELECT COUNT(*) AS n FROM events');
  const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );

  const listeners = new Set<(e: Event) => void>();

  function toEvent(r: Row): Event {
    return { ...(JSON.parse(r.body) as EventBody), id: r.id, ticketId: r.ticket_id, at: r.at };
  }

  const store: Store = {
    append(ticketId, body) {
      const at = new Date().toISOString();
      const json = JSON.stringify(body);
      const { lastInsertRowid } = insert.run(ticketId, at, json);
      // Read back from what was stored rather than reused, so a subscriber sees
      // exactly what a later read will: an optional field left undefined is gone,
      // not carried along in memory as a key with nothing in it.
      const event = toEvent({ id: Number(lastInsertRowid), ticket_id: ticketId, at, body: json });
      for (const fn of listeners) fn(event);
      return event;
    },

    eventsFor(ticketId) {
      return (selectForTicket.all(ticketId) as Row[]).map(toEvent);
    },

    ticket(ticketId) {
      return deriveTicket(store.eventsFor(ticketId));
    },

    ticketIds() {
      const created = (selectIds.all() as { ticket_id: string }[]).map((r) => r.ticket_id);
      const moves = (selectMoves.all() as { ticket_id: string; before: string | null }[]).map(
        (r) => ({ id: r.ticket_id, before: r.before }),
      );
      return moves.length === 0 ? created : ordered(created, moves);
    },

    tickets() {
      return store.ticketIds().map((id) => store.ticket(id));
    },

    eventCount() {
      return Number((countEvents.get() as { n: number | bigint }).n);
    },

    policy() {
      const policy = { ...DEFAULT_POLICY };
      for (const key of POLICY_KEYS) {
        const row = selectSetting.get(key) as { value: string } | undefined;
        if (row) policy[key] = Number(row.value);
      }
      return policy;
    },

    setPolicy(patch) {
      // Checked before anything is written, so a bad second limit cannot leave the
      // first one changed. Every limit is a positive number and two of them are
      // counts, which is the whole of what "valid" means here.
      for (const key of POLICY_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
          throw new Error(`${key} must be a number of at least 1, got ${String(value)}`);
        }
        if (key !== 'maxTicketUsd' && !Number.isInteger(value)) {
          throw new Error(`${key} must be a whole number, got ${value}`);
        }
      }
      for (const key of POLICY_KEYS) {
        const value = patch[key];
        if (value !== undefined) upsertSetting.run(key, String(value));
      }
      return store.policy();
    },

    stopped() {
      return (selectSetting.get(STOPPED) as { value: string } | undefined)?.value === 'true';
    },

    setStopped(on) {
      upsertSetting.run(STOPPED, String(on));
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    close() {
      listeners.clear();
      db.close();
    },
  };

  return store;
}
