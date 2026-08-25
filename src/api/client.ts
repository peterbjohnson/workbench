import type { Event } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import type { Policy } from '../domain/rules.ts';
import type { Doc, DocKind } from './documents.ts';
import type { Setting } from './settings.ts';

/**
 * The reply as an object, or null if it was not one. Null is the honest answer for
 * a body that did not parse *and* for one that parsed to something else — `null`
 * and `"ok"` are both valid JSON and neither is a reply this API ever sends.
 */
function asObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The CLI and the board both reach the workbench through this. Nothing else does. */
export function createClient(baseUrl: string) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
      });
    } catch {
      throw new Error(`no workbench at ${baseUrl} — start one with: wb serve`);
    }

    const body = asObject(await response.text());

    // A reply that failed is allowed to carry no JSON. The workbench always sends
    // a reason, but a proxy in front of it or a crash underneath it writes
    // whatever it likes, and the status is still worth reporting.
    if (!response.ok) throw new Error(String(body?.['error'] ?? `HTTP ${response.status}`));

    // A reply that succeeded is not. Every route answers with a JSON object, so
    // anything else means whatever is on that port is not the workbench — which
    // has to be said rather than read as an answer with every field missing.
    if (body === null) {
      const kind = response.headers.get('content-type')?.split(';')[0] ?? 'nothing';
      throw new Error(`${baseUrl}${path} answered with ${kind}, not JSON — is that a workbench?`);
    }

    return body as T;
  }

  const post = <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

  return {
    tickets: () => call<{ tickets: Ticket[] }>('/tickets').then((r) => r.tickets),

    ticket: (id: string) => call<{ ticket: Ticket; events: Event[] }>(`/tickets/${id}`),

    /**
     * `from` starts the ticket on another ticket's branch, carrying on its work.
     * `requiresApproval: false` lets the plan go straight on to being built.
     * `waitsFor` holds it until those tickets have offered their work or ended.
     */
    create: (
      title: string,
      body: string,
      how: { from?: string; requiresApproval?: boolean; waitsFor?: string[] } = {},
    ) => post<{ ticket: Ticket }>('/tickets', { title, body, ...how }).then((r) => r.ticket),

    /** Whichever field is given replaces what was there; the other is left alone. */
    edit: (id: string, changes: { title?: string; body?: string }) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/edit`, changes).then((r) => r.ticket),

    queue: (id: string) => post<unknown>(`/tickets/${id}/queue`),
    backlog: (id: string) => post<unknown>(`/tickets/${id}/backlog`),

    /** Put it in front of `before` in the board's order, or last when null. */
    move: (id: string, before: string | null) =>
      post<{ tickets: Ticket[] }>(`/tickets/${id}/move`, { before }).then((r) => r.tickets),
    /**
     * Hold it until every one of `tickets` offers its work or ends. The whole set,
     * not a difference — an empty list is what lets it go.
     */
    wait: (id: string, tickets: string[]) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/wait`, { tickets }).then((r) => r.ticket),

    approve: (id: string) => post<unknown>(`/tickets/${id}/approve`),
    /** Send it back to be planned again. The expensive no; the reason goes to the plan. */
    reject: (id: string, reason: string) => post<unknown>(`/tickets/${id}/reject`, { reason }),
    /** Keep the work and put these right. The cheap no; it goes back to implement. */
    changes: (id: string, changes: string) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/changes`, { changes }).then((r) => r.ticket),
    answer: (id: string, answer: string) => post<unknown>(`/tickets/${id}/answer`, { answer }),
    /** Run the stage again from the top. For one that failed, not one that asked. */
    restart: (id: string) => post<unknown>(`/tickets/${id}/restart`),
    /** Offer what it has as a pull request, whatever the agents made of it. */
    ship: (id: string) => post<unknown>(`/tickets/${id}/ship`),
    cancel: (id: string, reason: string) => post<unknown>(`/tickets/${id}/cancel`, { reason }),

    policy: () => call<Policy>('/policy'),
    /** Change some of the limits, leaving the rest. Takes effect at once. */
    setPolicy: (patch: Partial<Policy>) =>
      call<Policy>('/policy', { method: 'PUT', body: JSON.stringify(patch) }),

    /** Every agent file, or every skill file, with its text. */
    docs: (kind: DocKind) => call<{ docs: Doc[] }>(`/${kind}s`).then((r) => r.docs),
    /** Save one, having checked it still loads. Refused, with the reason, if it does not. */
    saveDoc: (kind: DocKind, name: string, text: string) =>
      call<{ doc: Doc }>(`/${kind}s/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ text }),
      }).then((r) => r.doc),

    /** Everything the workbench is set to, editable and not. */
    settings: () => call<{ settings: Setting[] }>('/settings').then((r) => r.settings),
    setSettings: (patch: Record<string, unknown>) =>
      call<{ settings: Setting[] }>('/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }).then((r) => r.settings),
  };
}

export type Client = ReturnType<typeof createClient>;
