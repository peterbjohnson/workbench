import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Store } from '../store/store.ts';
import type { Event } from '../domain/events.ts';
import type { Config } from '../config.ts';
import { listDocs, writeDoc, type DocKind } from './documents.ts';
import { applySettings, settings } from './settings.ts';

/** The built board. `npm run build` puts it here; `npm run ui` serves it itself instead. */
export const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export type Api = {
  /** Returns the port it really got, which is not the one asked for when that is 0. */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
};

/**
 * The single way in. The CLI and the board are both clients of this, so nothing
 * is reachable from one and not the other. It decides nothing: every endpoint
 * either reads derived state or appends one event and lets the rules react.
 */
export function createApi(store: Store, config: Config): Api {
  const server = http.createServer((req, res) => {
    handle(store, config, req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        // Starting a second workbench is an ordinary mistake, not a crash. Without
        // this the port being taken reaches Node as an unhandled 'error' event and
        // prints a stack trace from net.js, which says nothing about what to do.
        server.once('error', (error: NodeJS.ErrnoException) => {
          reject(
            error.code === 'EADDRINUSE'
              ? new Error(
                  `a workbench is already running on port ${port}.\n` +
                    'Use it, or stop it first — every other command talks to it over HTTP.',
                )
              : error,
          );
        });

        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  store: Store,
  config: Config,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const ticketPath = /^\/tickets\/([^/]+)(\/[a-z]+)?$/.exec(route);
  const docPath = /^\/(agents|skills)\/([\w.-]+)$/.exec(route);

  // Who is answering, not merely that something is. `wb serve` asks this of a port
  // it finds taken, to tell a workbench for another repository — ordinary — from a
  // second one for this repository, which would share a database with the first.
  if (method === 'GET' && route === '/health') {
    return send(res, 200, { ok: true, home: config.home });
  }

  if (method === 'GET' && route === '/events') {
    return stream(store, req, res);
  }

  if (route === '/policy') {
    if (method === 'GET') return send(res, 200, store.policy());
    if (method === 'PUT') {
      const patch = await readJson(req);
      return refusable(res, () => store.setPolicy(patch));
    }
  }

  // How the workbench works, rather than what it is working on: the settings, and
  // the two kinds of writing every stage is briefed from. All of it is on disk or
  // in the database already — these routes only put it behind the same door.
  if (route === '/settings') {
    if (method === 'GET') return send(res, 200, { settings: settings(store, config) });
    if (method === 'PUT') {
      const patch = await readJson(req);
      return refusable(res, () => ({ settings: applySettings(store, config, patch) }));
    }
  }

  if (method === 'GET' && (route === '/agents' || route === '/skills')) {
    return send(res, 200, { docs: listDocs(config, kindOf(route)) });
  }

  if (method === 'PUT' && docPath) {
    const { text } = await readJson(req);
    if (typeof text !== 'string') return send(res, 400, { error: 'nothing to save' });
    const kind = kindOf(docPath[1] as string);
    const name = docPath[2] as string;
    return refusable(res, () => ({ doc: writeDoc(config, kind, name, text) }));
  }

  if (route === '/tickets') {
    if (method === 'GET') return send(res, 200, { tickets: store.tickets() });
    if (method === 'POST') {
      const { title, body, from, requiresApproval, waitsFor: after } = await readJson(req);
      if (typeof title !== 'string' || title.trim() === '') {
        return send(res, 400, { error: 'a ticket needs a title' });
      }

      // Carrying on from another ticket means starting on its branch, so there
      // has to be one, with something on it. Refused here rather than failing
      // later in git, where the reason would be someone else's error message.
      const continues = from === undefined || from === null ? undefined : String(from);
      if (continues !== undefined) {
        if (!store.ticketIds().includes(continues)) {
          return send(res, 400, { error: `no ticket ${continues} to continue` });
        }
        if (store.ticket(continues).commits.length === 0) {
          return send(res, 400, { error: `${continues} left no work to continue` });
        }
      }

      // What it starts after, said when the ticket is written — which is the
      // moment you know it. Checked before anything is created, so a typo does
      // not leave a ticket behind that says nothing about what it waits for.
      const waitsFor = (Array.isArray(after) ? after : [])
        .map((one) => String(one).trim())
        .filter((one) => one !== '');
      for (const other of waitsFor) {
        if (!store.ticketIds().includes(other)) {
          return send(res, 400, { error: `no ticket ${other} to wait for` });
        }
      }

      const id = nextId(store);
      store.append(id, {
        type: 'ticket_created',
        title,
        body: String(body ?? ''),
        continues,
        // Recorded only when the gate is being skipped. Anything else — true, or
        // nothing said — is the default, and writing it down would say nothing.
        ...(requiresApproval === false ? { requiresApproval: false } : {}),
      });
      // Its own event rather than a field of the creation, so there is one way a
      // ticket comes to wait for something whenever it is said. A new ticket
      // cannot close a ring, so there is nothing here for `cannotWaitFor` to do.
      if (waitsFor.length > 0) {
        store.append(id, { type: 'waits_for', tickets: [...new Set(waitsFor)] });
      }
      return send(res, 201, { ticket: store.ticket(id) });
    }
  }

  if (ticketPath) {
    const id = ticketPath[1] as string;
    const action = ticketPath[2]?.slice(1);

    if (!store.ticketIds().includes(id)) {
      return send(res, 404, { error: `no ticket ${id}` });
    }

    if (method === 'GET' && action === undefined) {
      return send(res, 200, { ticket: store.ticket(id), events: store.eventsFor(id) });
    }

    if (method === 'POST') {
      const payload = await readJson(req);
      switch (action) {
        case 'edit': {
          const title = 'title' in payload ? String(payload['title']).trim() : undefined;
          const body = 'body' in payload ? String(payload['body']) : undefined;
          if (title === '') return send(res, 400, { error: 'a ticket needs a title' });
          if (title === undefined && body === undefined) {
            return send(res, 400, { error: 'nothing to change' });
          }
          store.append(id, { type: 'ticket_edited', title, body });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'queue':
          store.append(id, { type: 'queued' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'backlog':
          store.append(id, { type: 'backlogged' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'move': {
          // Absent and null both mean the end of the board, so "move it last" is
          // an empty body rather than a special word.
          const raw = payload['before'];
          const before = raw === undefined || raw === null ? null : String(raw);
          if (before === id) return send(res, 400, { error: 'a ticket cannot go before itself' });
          if (before !== null && !store.ticketIds().includes(before)) {
            return send(res, 400, { error: `no ticket ${before} to go before` });
          }
          store.append(id, { type: 'moved', before });
          return send(res, 200, { tickets: store.tickets() });
        }
        case 'wait': {
          // The whole set each time, so taking the last one off is an empty list
          // rather than a special word.
          const raw = payload['tickets'];
          const tickets = (Array.isArray(raw) ? raw : [])
            .map((one) => String(one).trim())
            .filter((one) => one !== '');

          for (const other of tickets) {
            const problem = cannotWaitFor(store, id, other);
            if (problem !== undefined) return send(res, 400, { error: problem });
          }

          store.append(id, { type: 'waits_for', tickets: [...new Set(tickets)] });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'ship':
          store.append(id, { type: 'shipped' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'restart':
          store.append(id, { type: 'stage_restarted' });
          return send(res, 200, { ticket: store.ticket(id) });
        // The other half of restarting: same stage, keeping its conversation.
        // Only for a ticket that was stopped mid-run, though — a ticket blocked on
        // a question is parked in the same place with no run to carry on, and
        // appending this to it would throw the question away for nothing.
        case 'continue': {
          const t = store.ticket(id);
          if (!t.interrupted) {
            return send(res, 400, {
              error: t.question
                ? `${id} is waiting on an answer, not on being picked up — answer it instead`
                : `${id} was not stopped mid-stage — there is no run to carry on, so restart it`,
            });
          }
          store.append(id, { type: 'stage_continued' });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'approve':
          store.append(id, { type: 'plan_approved' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'reject': {
          const reason = String(payload['reason'] ?? '').trim();
          if (reason === '') return send(res, 400, { error: 'say why, so the next plan knows' });
          store.append(id, { type: 'plan_rejected', reason });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'changes': {
          const changes = String(payload['changes'] ?? '').trim();
          if (changes === '') return send(res, 400, { error: 'say what to put right' });
          // Nothing to put right before there is a plan, and no plan means the
          // stage this sends the ticket to has nothing to work from.
          if (store.ticket(id).plan === null) {
            return send(res, 400, { error: 'nothing has been planned yet — send it back instead' });
          }
          store.append(id, { type: 'changes_requested', changes });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'answer': {
          const answer = String(payload['answer'] ?? '').trim();
          if (answer === '') return send(res, 400, { error: 'an answer is needed' });
          store.append(id, { type: 'question_answered', answer });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'cancel': {
          const reason = String(payload['reason'] ?? '').trim() || 'no reason given';
          store.append(id, { type: 'cancelled', reason });
          return send(res, 200, { ticket: store.ticket(id) });
        }
      }
    }
  }

  // Anything left that could be a page is the board itself. The API's routes are
  // all above, so nothing here can shadow one.
  if (method === 'GET') return serveBoard(res, route);

  send(res, 404, { error: `no route for ${method} ${route}` });
}

/**
 * The built board, straight off disk. It is a single page with everything in the
 * fragment, so there is no routing to do — a request either names a built file or
 * it names nothing.
 */
async function serveBoard(res: http.ServerResponse, route: string): Promise<void> {
  const file = path.resolve(UI_DIST, route === '/' ? 'index.html' : route.slice(1));
  if (file !== UI_DIST && !file.startsWith(UI_DIST + path.sep)) {
    return send(res, 403, { error: 'outside the board' });
  }

  let body: Buffer;
  try {
    body = await fs.readFile(file);
  } catch {
    if (route !== '/') return send(res, 404, { error: `nothing at ${route}` });
    // Not built is the ordinary state of a fresh clone, and a 404 here reads as a
    // broken workbench rather than as one missing step.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Workbench</title>' +
        '<body style="font:15px/1.6 system-ui;padding:3rem;max-width:34rem">' +
        '<h1>The board is not built yet</h1>' +
        '<p>Build it once, from <code>workbench/</code>:</p>' +
        '<pre><code>npm run build</code></pre>' +
        '<p>Then reload. To work on the board itself, <code>npm run ui</code> serves it ' +
        'with reloading, and talks to this workbench.</p>',
    );
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    // The page names its assets by content hash, so they can be cached for ever
    // and the page itself never can: cache it and a rebuilt board keeps serving
    // the old one, which looks exactly like a change that did not work.
    'cache-control': route === '/' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

/** Server-sent events, so the board reflects state without polling. */
function stream(store: Store, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = store.subscribe((event: Event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', unsubscribe);
}

/**
 * Something the caller can be wrong about. What the settings and the two kinds of
 * document refuse — a limit below one, an agent file missing a field — is a thing
 * the person typing it can put right, so it comes back as a complaint about their
 * value rather than as a 500 about the workbench.
 */
function refusable(res: http.ServerResponse, work: () => unknown): void {
  try {
    send(res, 200, work());
  } catch (error: unknown) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** `/agents` and `/skills` are the routes; `agent` and `skill` are the things. */
function kindOf(route: string): DocKind {
  return route.includes('agent') ? 'agent' : 'skill';
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('the request body was not valid JSON');
  }
}

/**
 * Why `id` may not wait for `other`, if it may not. A ring of tickets waiting on
 * each other would never start and nothing downstream would say why, so it is
 * refused here — the one place that can see the whole chain before it exists.
 */
function cannotWaitFor(store: Store, id: string, other: string): string | undefined {
  if (other === id) return 'a ticket cannot wait for itself';
  if (!store.ticketIds().includes(other)) return `no ticket ${other} to wait for`;

  // Everything `other` is already waiting on, however far back. Reaching `id`
  // means the new condition would close a ring.
  const seen = new Set<string>();
  const toVisit = [other];
  while (toVisit.length > 0) {
    const at = toVisit.pop() as string;
    if (seen.has(at)) continue;
    seen.add(at);
    if (at === id) return `${other} already waits for ${id}, and they would hold each other up`;
    toVisit.push(...store.ticket(at).waitsFor);
  }
  return undefined;
}

/** Short, human ids: t1, t2, ... */
function nextId(store: Store): string {
  const used = store.ticketIds().map((id) => Number(id.replace(/^t/, '')));
  return `t${Math.max(0, ...used.filter(Number.isFinite)) + 1}`;
}
