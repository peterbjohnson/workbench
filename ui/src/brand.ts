/**
 * The colour this workbench was given, which its top bar is drawn in.
 *
 * Unlike the theme this belongs to the instance and not to the browser: it is what
 * tells two boards on two ports apart, so it comes from the server's settings and is
 * not remembered here. Nothing else reads it — an arbitrary colour cannot be trusted
 * behind white text, so it tints one band rather than becoming the accent.
 */
const BRAND_KEY = '--brand';

/** A colour the settings would have accepted: six hex digits, as the picker gives. */
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
