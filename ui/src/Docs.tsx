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
  empty: string;
}) {
  const { kind, docs } = props;
  const [name, setName] = useState<string | null>(null);
  // Kept per document, so switching away from an edit and back does not lose it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (docs === null) return <div className="empty">Reading…</div>;
  if (docs.length === 0) return <div className="empty">{props.empty}</div>;

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

  return (
    <div className="page docs">
      <nav>
        {docs.map((d) => (
          <button
            key={d.name}
            type="button"
            className={d.name === doc.name ? 'picked' : ''}
            onClick={() => setName(d.name)}
          >
            <span className="name">
              {d.name}
              {(drafts[d.name] ?? d.text) !== d.text && <b title="unsaved changes"> •</b>}
            </span>
            <span className="quiet">{d.about}</span>
          </button>
        ))}
      </nav>

      <article>
        <div className="head">
          <h2>{doc.name}</h2>
          <span className="quiet mono">{doc.where}</span>
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
          </div>
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
