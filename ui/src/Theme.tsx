import { MODES, useTheme, type Mode } from './theme.ts';

/**
 * What each mode is called on the control. "Auto" rather than "System" because
 * the sentence it has to finish is "which of these three is on", and the answer
 * is that nobody chose — not that a particular one was chosen and named after
 * the machine.
 */
const LABEL: Record<Mode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Light or dark, or neither. All three at once rather than a button that cycles
 * through them: the mode it is in is visible without pressing anything, and any
 * mode is one press away rather than up to two.
 *
 * It sits at the end of the header, past the counts. It is about the browser
 * rather than about the work, so it is the last thing on the bar and the dimmest
 * — nothing here may compete with "waiting on you".
 */
export function Theme() {
  const [mode, choose] = useTheme();

  return (
    <div className="theme" role="group" aria-label="Colour mode">
      {MODES.map((name) => (
        <button
          key={name}
          type="button"
          className={name === mode ? 'picked' : ''}
          aria-pressed={name === mode}
          onClick={() => choose(name)}
        >
          {LABEL[name]}
        </button>
      ))}
    </div>
  );
}
