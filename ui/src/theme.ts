import { useCallback, useEffect, useState } from 'react';

/**
 * Light, dark, or whatever the machine is set to. Three states rather than a
 * switch: a switch has to start somewhere, and starting it at light on a dark
 * machine is a worse default than having no opinion at all.
 */
export const MODES = ['system', 'light', 'dark'] as const;

export type Mode = (typeof MODES)[number];

/**
 * Where the choice is kept. It is about this browser rather than about the
 * workbench — the same server read from a laptop in the evening and a desktop
 * in the morning should not be forced into one answer — so it stays here and
 * not in the settings the server holds.
 *
 * **This string is also written out in `ui/index.html`.** The pre-paint script
 * there cannot import anything — that is the whole point of it — so the two have
 * to be changed together.
 */
const KEY = 'workbench.theme';

function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

/** What was chosen last, or no opinion if nothing was or the store is unreadable. */
function stored(): Mode {
  try {
    const held = localStorage.getItem(KEY);
    return isMode(held) ? held : 'system';
  } catch {
    // Private windows and blocked storage throw on read. The theme is not worth
    // a blank page, so an unusable store just means the choice does not persist.
    return 'system';
  }
}

/**
 * Put the choice on the document, where the stylesheet reads it. `system` takes
 * the attribute off rather than setting it to anything — the absence is what
 * lets the `prefers-color-scheme` block apply.
 */
function apply(mode: Mode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

/**
 * The current choice and a way to change it. The same three lines run at load in
 * `index.html`, before React exists, so the first paint is already in the right
 * mode — this hook is only what keeps the control and the document agreeing
 * after that.
 */
export function useTheme(): [Mode, (mode: Mode) => void] {
  const [mode, setMode] = useState<Mode>(stored);

  useEffect(() => apply(mode), [mode]);

  const choose = useCallback((next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // As above: it applies for this session and is forgotten by the next.
    }
  }, []);

  return [mode, choose];
}
