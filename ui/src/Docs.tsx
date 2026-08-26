import { useState } from 'react';

import type { Doc, DocKind } from '../../src/api/documents.ts';
import { Markdown } from './Markdown.tsx';
import { wb } from './wb.ts';

/**
 * The writing the workbench runs on: what each stage is told to do, and the
 * expertise every stage is handed. One page for both, because they are the same
 * thing to work with — a markdown file you read, change and save.
 *
 * Read is the default and Edit is a switch, because these are read far more often
 * than they are changed and rendered markdown is what they were written to be.
 */
export function Docs(props: {
  kind: DocKind;
  /** The files, held by the board because its tabs count them. Null while reading. */
  docs: Doc[] | null;
  onSaved: (doc: Doc) => void;
  /** Skills only. The four stages are fixed, so there is no agent to add or remove. */
  onCreated?: (doc: Doc) => void;
  onDeleted?: (name: string) => void;
  empty: string;
}) {
  const { kind, docs } = props;
  const [name, setName] = useState<string | null>(null);
  // Kept per document, so switching away from an edit and back does not lose it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name being typed for a new skill, or null when none is being added.
  const [adding, setAdding] = useState<string | null>(null);
  // Whether the question has been asked about the one being read. Deleting takes a
  // directory with it, so the second click answers a question rather than repeating
  // the first — and switching document puts it back.
  const [confirming, setConfirming] = useState(false);

  if (docs === null) return <div className="empty">Reading…</div>;

  const create = () => {
    setSaving(true);
    wb.createDoc(kind, (adding ?? '').trim())
      .then((made) => {
        props.onCreated?.(made);
        setName(made.name);
        setAdding(null);
        // Armed against the one you were reading, which is not this one.
        setConfirming(false);
        setError(null);
      })
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setSaving(false));
  };

  const newSkill =
    kind !== 'skill' ? null : adding === null ? (
      <button className="new" type="button" onClick={() => setAdding('')}>
        New skill
      </button>
    ) : (
      <div className="new row">
        <input
          value={adding}
          autoFocus
          placeholder="lowercase-with-dashes"
          spellCheck={false}
          onChange={(e) => setAdding(e.target.value)}
        />
        <button className="go" type="button" disabled={saving} onClick={create}>
          Create
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(null);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    );

  // The workbench ships no skills, so this is the page a new one lands on — which is
  // exactly where adding the first has to be possible.
  if (docs.length === 0) {
    return (
      <div className="page docs">
        <nav>
          <span className="quiet">{props.empty}</span>
          {newSkill}
          {error !== null && <div className="error">{error}</div>}
        </nav>
      </div>
    );
  }

  const doc = docs.find((d) => d.name === name) ?? (docs[0] as Doc);
  const draft = drafts[doc.name] ?? doc.text;
  const dirty = draft !== doc.text;

  const save = () => {
    setSaving(true);
    wb.saveDoc(kind, doc.name, draft)
      .then((saved) => {
        props.onSaved(saved);
        setDrafts({ ...drafts, [saved.name]: saved.text });
        setError(null);
      })
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setSaving(false));
  };

  const remove = () => {
    setSaving(true);
    wb.deleteDoc(kind, doc.name)
      .then((gone) => {
        props.onDeleted?.(gone);
        setConfirming(false);
        setName(null);
        setError(null);
      })
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="page docs">
      <nav>
        {docs.map((d) => (
          <button
            key={d.name}
            type="button"
            className={d.name === doc.name ? 'picked' : ''}
            onClick={() => {
              setName(d.name);
              setConfirming(false);
            }}
          >
            <span className="name">
              {d.name}
              {(drafts[d.name] ?? d.text) !== d.text && <b title="unsaved changes"> •</b>}
            </span>
            <span className="quiet">{d.about}</span>
          </button>
        ))}
        {newSkill}
      </nav>

      <article>
        <div className="head">
          <h2>{doc.name}</h2>
          <span className="quiet mono">{doc.where}</span>
          {confirming ? (
            <div className="row confirm">
              <span>
                Delete <b>{doc.name}</b> and everything in its directory? This cannot be undone.
              </span>
              <button className="danger" type="button" disabled={saving} onClick={remove}>
                {saving ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row">
              <button type="button" onClick={() => setEditing(!editing)}>
                {editing ? 'Read' : 'Edit'}
              </button>
              <button className="go" type="button" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => setDrafts({ ...drafts, [doc.name]: doc.text })}
              >
                Revert
              </button>
              {kind === 'skill' && (
                <button className="danger" type="button" onClick={() => setConfirming(true)}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {error !== null && <div className="error">{error}</div>}

        {editing ? (
          <textarea
            className="editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDrafts({ ...drafts, [doc.name]: e.target.value })}
          />
        ) : (
          <Markdown text={draft} />
        )}

        <p className="quiet">
          Saved only if it still loads — a file that does not would stop every stage of every
          ticket. A ticket already running keeps what it was given; the next one to start reads
          this.
        </p>
      </article>
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
