/**
 * The colour this workbench was given, which its top bar and the page behind its
 * board are tinted with.
 *
 * Unlike the theme this belongs to the instance and not to the browser: it is what
 * tells two boards on two ports apart, so it comes from the server's settings and is
 * not remembered here. It is one of the offered set rather than any colour at all,
 * which is what lets it go behind a whole board — the stylesheet mixes it faintly
 * into the page and more strongly into the bar, and it never becomes the accent.
 */
const BRAND_KEY = '--brand';

/** A colour the settings would have accepted: six hex digits, as the presets are. */
export function isColour(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Put the colour on the document, where the stylesheet reads it. No colour takes the
 * property off rather than setting it to anything — the absence is what lets each
 * `var(--brand, …)` fall back, and a board with no colour set is one nothing here
 * has touched.
 */
export function applyBrand(colour: string | null): void {
  const root = document.documentElement;
  if (colour === null) root.style.removeProperty(BRAND_KEY);
  else root.style.setProperty(BRAND_KEY, colour);
}
