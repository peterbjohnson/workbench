import { useEffect, useState } from 'react';

import type { Setting } from '../../src/api/settings.ts';
import { applyBrand, isColour } from './brand.ts';
import { wb } from './wb.ts';

/**
 * Everything the workbench is set to, in one page: the limits it works under, how
 * it works, and where it put things. It is drawn by walking the list the server
 * sends — a setting appears here by existing there, so the two cannot drift.
 *
 * Changes are held until you save them, and saved together. Half a change is worse
 * than none: a cost limit raised without the cycle limit is a ticket that runs out
 * of one thing instead of the other.
 */
export function Settings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    wb.settings()
      .then((loaded) => live && setSettings(loaded))
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, []);

  // The header takes the colour as the picker moves, so it is seen where it will be
  // rather than in a swatch beside a bar that is still the old one. Leaving with an
  // unsaved draft puts the saved colour back: nothing was saved, so nothing changed.
  const colour = settings?.find((s) => s.key === 'colour');
  const showing = colour === undefined ? null : (drafts[colour.key] ?? show(colour));
  useEffect(() => {
    if (colour === undefined || showing === null) return;
    applyBrand(isColour(showing) ? showing : null);
    return () => applyBrand(isColour(colour.value) ? colour.value : null);
  }, [colour, showing]);

  if (settings === null) return <div className="empty">{error ?? 'Reading…'}</div>;

  const changed = settings.filter((s) => drafts[s.key] !== undefined && drafts[s.key] !== show(s));
  const restarts = changed.some((s) => s.restart);

  const save = () => {
    setSaving(true);
    setSaved(false);
    const patch = Object.fromEntries(changed.map((s) => [s.key, drafts[s.key]]));
    wb.setSettings(patch)
      .then((after) => {
        setSettings(after);
        setDrafts({});
        setError(null);
        setSaved(true);
        // Nothing was appended, so no event will redraw the board — and the limit
        // in the header is the one that was just changed.
        onSaved();
      })
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="page settings">
      {groups(settings).map(([group, of]) => (
        <section key={group}>
          <h3>{group}</h3>
          {of.map((s) => (
            <div className="setting" key={s.key}>
              <label htmlFor={`set-${s.key}`}>{s.label}</label>
              <Field
                setting={s}
                value={drafts[s.key] ?? show(s)}
                onChange={(v) => {
                  setSaved(false);
                  setDrafts({ ...drafts, [s.key]: v });
                }}
              />
              <span className="quiet">
                {s.about}
                {s.restart && ' Takes effect when the workbench is next started.'}
              </span>
            </div>
          ))}
        </section>
      ))}

      {error !== null && <div className="error">{error}</div>}

      <div className="row save">
        <button
          className="go"
          type="button"
          disabled={changed.length === 0 || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : `Save${changed.length > 0 ? ` ${changed.length}` : ''}`}
        </button>
        <button
          type="button"
          disabled={changed.length === 0 || saving}
          onClick={() => setDrafts({})}
        >
          Revert
        </button>
        <span className="quiet">
          {changed.length === 0
            ? saved
              ? 'Saved.'
              : 'Nothing changed.'
            : restarts
              ? 'Some of these take effect when the workbench is next started.'
              : 'These take effect at once.'}
        </span>
      </div>
    </div>
  );
}

function Field(props: { setting: Setting; value: string; onChange: (value: string) => void }) {
  const { setting, value } = props;
  const id = `set-${setting.key}`;

  // A fact about this installation, not a decision. Shown as what it is rather
  // than as a box you can type in and cannot save.
  if (!setting.writable) {
    return (
      <output className="mono fixed" id={id}>
        {value || '—'}
      </output>
    );
  }

  if (setting.type === 'choice') {
    return (
      <select id={id} value={value} onChange={(e) => props.onChange(e.target.value)}>
        {(setting.choices ?? []).map((choice) => (
          <option key={choice}>{choice}</option>
        ))}
      </select>
    );
  }

  // The machine's own colour picker, because "any colour" is what was asked for and
  // a list of six would not be it. The hex beside it is what was chosen, and "None"
  // is the way back out — a picker has no empty position to return the bar to.
  if (setting.type === 'colour') {
    return (
      <span className="swatch">
        <input
          id={id}
          type="color"
          value={isColour(value) ? value : '#808080'}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <span className="mono">{value || 'none'}</span>
        <button type="button" disabled={value === ''} onClick={() => props.onChange('')}>
          None
        </button>
      </span>
    );
  }

  if (setting.type === 'lines') {
    return (
      <textarea
        id={id}
        className="mono"
        rows={Math.max(2, value.split('\n').length)}
        value={value}
        spellCheck={false}
        placeholder="one to a line"
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      id={id}
      type={setting.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/** A setting's value as text, which is what every field edits. */
function show(setting: Setting): string {
  return Array.isArray(setting.value) ? setting.value.join('\n') : String(setting.value);
}

/** In the order the server sent them, one section per group. */
function groups(settings: Setting[]): [string, Setting[]][] {
  const out = new Map<string, Setting[]>();
  for (const setting of settings) {
    out.set(setting.group, [...(out.get(setting.group) ?? []), setting]);
  }
  return [...out];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
