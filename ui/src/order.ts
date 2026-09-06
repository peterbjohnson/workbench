import { useCallback, useState } from 'react';

import { WHOLE_OF_DONE, type DoneView } from '../../src/domain/board.ts';

/**
 * Where the choice is kept. It is about this browser rather than about the
 * workbench — how the finished work is read is nobody's decision but the reader's
 * — so it stays here and not in the settings the server holds, the same way the
 * theme does.
 */
const KEY = 'workbench.done.order';

/**
 * How Done was last read, or the whole of it newest first if nothing was chosen.
 * That default is the point: the ticket that just finished is at the top of the
 * longest column on the board without anyone pressing anything.
 *
 * The key held a bare `'newest'` or `'oldest'` before there was anything else to
 * choose, and a browser that saved one still has it — so it is read as the sort it
 * names rather than thrown away, which would silently flip somebody's column round.
 */
function stored(): DoneView {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Private windows and blocked storage throw on read. An unusable store just
    // means the choice does not persist.
    return WHOLE_OF_DONE;
  }

  if (saved === null) return WHOLE_OF_DONE;
  if (saved === 'newest' || saved === 'oldest') return { ...WHOLE_OF_DONE, sort: saved };

  try {
    // Whatever was written, checked field by field: a key from an older or newer
    // board must not be able to leave the column sorted by something that is not
    // a sort, which draws nothing at all.
    const held = JSON.parse(saved) as Partial<DoneView>;
    return {
      sort: SORTS.includes(held.sort as DoneView['sort'])
        ? (held.sort as DoneView['sort'])
        : 'newest',
      outcome: typeof held.outcome === 'string' ? held.outcome : 'all',
      prefix: typeof held.prefix === 'string' ? held.prefix : 'all',
    };
  } catch {
    return WHOLE_OF_DONE;
  }
}

/** Every sort there is, which is also what the control offers, in its order. */
export const SORTS: readonly DoneView['sort'][] = ['newest', 'oldest', 'cost', 'title', 'outcome'];

/** The current choice and a way to change part of it. */
export function useDoneView(): [DoneView, (change: Partial<DoneView>) => void] {
  const [view, setView] = useState<DoneView>(stored);

  const choose = useCallback((change: Partial<DoneView>) => {
    setView((held) => {
      const next = { ...held, ...change };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // As above: it applies for this session and is forgotten by the next.
      }
      return next;
    });
  }, []);

  return [view, choose];
}
