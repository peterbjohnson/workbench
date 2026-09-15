import { createClient } from '../../src/api/client.ts';

/**
 * The board is a client of the API, through the same code the command line uses.
 * Nothing is reachable from one and not the other, and it stays that way because
 * there is only one file to add anything to.
 */
export const wb = createClient('');

/** What a rejected call from it reads as. Here because that is where the rejections come from. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
