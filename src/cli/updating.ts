/**
 * What `wb serve` asks when an update is waiting, and what it does with the answer.
 *
 * The awkward part is that `npm install` replaces the code on disk while this process
 * is still running the old build. So taking the update cannot mean carrying on here:
 * it means installing, then handing over to a fresh `wb serve` started from what was
 * just written. The command you typed becomes the parent of the one that serves.
 *
 * Its own module because the command line runs itself on import, and a question worth
 * testing should not need the process started to read it.
 */

/** The question, with both answers on it. */
export function offer(from: string, to: string): string {
  return (
    `⬆️  an update is waiting: ${from} → ${to}.\n` +
    '    Install it and start the new one, or serve this version as it is? [y/N] '
  );
}

/**
 * Which replies take the update. Empty is a no.
 *
 * `choosePort` defaults to yes, but moving a port is not the same act: this one
 * replaces the code the agents run under, and the design is against that happening
 * without anyone asking for it. So it wants a typed `y`, not a blind Enter.
 */
export function taken(answer: string): boolean {
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

/**
 * The child to start once the install has landed: this Node, running the same command
 * again. `argv[1]` is the installed `bin/wb.mjs`, which imports `dist/` — so the child
 * reads the build npm has just put there, which is the whole point of relaunching.
 */
export function relaunch(
  execPath: string,
  argv: readonly string[],
): { command: string; args: string[] } {
  return { command: execPath, args: [...argv.slice(1)] };
}

/**
 * Set on the child so it does not offer again.
 *
 * A remote whose `ls-remote` commit npm does not resolve to — a spec following a
 * branch whose tip has moved on, most often — would look out of date the moment it
 * started, and offer, and relaunch, forever.
 */
export const CHILD_ENV = 'WB_UPDATE_TAKEN';
