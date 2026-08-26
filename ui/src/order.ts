import { useCallback, useState } from 'react';

import type { Order } from '../../src/domain/board.ts';

/**
 * Where the choice is kept. It is about this browser rather than about the
 * workbench — the order Done is read in is nobody's decision but the reader's —
 * so it stays here and not in the settings the server holds, the same way the
 * theme does.
 */
const KEY = 'workbench.done.order';

/**
 * Which end of Done was last read from, newest first if nothing was chosen. That
 * default is the point: the ticket that just finished is at the top of the longest
 * column on the board without anyone pressing anything.
 */
function stored(): Order {
  try {
    return localStorage.getItem(KEY) === 'oldest' ? 'oldest' : 'newest';
  } catch {
    // Private windows and blocked storage throw on read. An unusable store just
    // means the choice does not persist.
    return 'newest';
  }
}

/** The current choice and a way to change it. */
export function useOrder(): [Order, (order: Order) => void] {
  const [order, setOrder] = useState<Order>(stored);

  const choose = useCallback((next: Order) => {
    setOrder(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // As above: it applies for this session and is forgotten by the next.
    }
  }, []);

  return [order, choose];
}
