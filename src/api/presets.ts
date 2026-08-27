/**
 * The colours a workbench may be given. A set rather than a picker: this colour is
 * mixed into the top bar and into the page behind the board, and every one of these
 * was chosen to be quiet enough to sit under a board's worth of writing in either
 * mode. An arbitrary hex was not, which is what made picking one a way to end up
 * with a board nobody wants to look at.
 *
 * Nothing is imported here on purpose. The server checks against this list and the
 * board draws its swatches from it, so it has to be readable from both.
 */
export const PRESETS: { name: string; value: string }[] = [
  { name: 'Slate', value: '#4a6b8a' },
  { name: 'Teal', value: '#2f7d76' },
  { name: 'Moss', value: '#5c7a45' },
  { name: 'Ochre', value: '#a8802c' },
  { name: 'Clay', value: '#b4643c' },
  { name: 'Rose', value: '#b05a6b' },
  { name: 'Plum', value: '#7a5a91' },
  { name: 'Graphite', value: '#5f5c57' },
];

/** The same list as the settings offer it and check against it. */
export const PRESET_VALUES: string[] = PRESETS.map((preset) => preset.value);
