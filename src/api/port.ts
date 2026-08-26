import net from 'node:net';

/**
 * Who is on a port.
 *
 * `free` means `wb serve` could bind it. `workbench` means one answered and said
 * which home it is serving, which is the only way to tell a second workbench for
 * this repository — a mistake — from one for another repository, which is how the
 * workbench is meant to be run. `stranger` is anything else listening: someone
 * else's server, whose business is not ours to guess at.
 */
export type Occupant =
  { kind: 'free' } | { kind: 'workbench'; home: string } | { kind: 'stranger' };

/** How long a workbench gets to say who it is before it is treated as a stranger. */
const ANSWER_MS = 500;

/**
 * Asked in two steps, because neither answers on its own: binding says whether the
 * port is taken but not by whom, and `/health` says who but only if they are there.
 */
export async function occupantOf(port: number): Promise<Occupant> {
  if (await bindable(port)) return { kind: 'free' };

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(ANSWER_MS),
    });
    const body = (await res.json()) as { home?: unknown };
    if (typeof body.home === 'string') return { kind: 'workbench', home: body.home };
  } catch {
    // Refused the question, took too long, or was never speaking HTTP. All of them
    // mean the same thing here: something is there and it is not one of ours.
  }
  return { kind: 'stranger' };
}

/**
 * The first port from `from` upwards that nothing is on. Bounded: a machine with
 * twenty consecutive ports in use has a problem worth reporting rather than one
 * worth walking past.
 */
export async function nextFree(from: number, span = 20): Promise<number | undefined> {
  for (let port = from; port < from + span; port++) {
    if (await bindable(port)) return port;
  }
  return undefined;
}

/**
 * Whether `wb serve` could listen here, asked by doing it briefly. The same host as
 * the real server, because a port free on one interface can be taken on another.
 */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
