export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What would not merge, said so a person can act on it: the base is a commit and
 * is worth naming as one, and anything else is a ticket's branch, which says which
 * ticket without anybody having to look a sha up.
 */
export function describeRef(ref: string, base: string): string {
  return ref === base
    ? `${base.slice(0, 8)}, which the base has moved on to`
    : `${ref}, whose work it waits for`;
}
