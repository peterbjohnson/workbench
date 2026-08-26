/**
 * A ticket's prefix lives in its title — `fix: Card drag leaves board lit` — rather
 * than in a field of its own. Nothing but the form reads it, so it stays a naming
 * convention: these two put it on and take it off again, and everything else in the
 * workbench sees one title string.
 */

/** The title as it is saved. No prefix chosen leaves the title exactly as typed. */
export function joinTitle(prefix: string, title: string): string {
  return prefix === '' ? title.trim() : `${prefix}: ${title.trim()}`;
}

/**
 * A saved title back into the two boxes it was written in. Only a prefix that is
 * still configured counts, so a title that merely has a colon in it comes back
 * whole rather than being silently cut in half.
 */
export function splitTitle(title: string, prefixes: string[]): { prefix: string; rest: string } {
  for (const prefix of prefixes) {
    if (title.startsWith(`${prefix}: `)) {
      return { prefix, rest: title.slice(prefix.length + 2) };
    }
  }
  return { prefix: '', rest: title };
}
