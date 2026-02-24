import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DocumentWithContent,
  deleteDocumentApi,
  fetchDocument,
  updateDocumentApi,
} from "../api";

marked.setOptions({ breaks: true, gfm: true });

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso + "Z").getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function DocumentViewer({
  projectId,
  docId,
}: {
  projectId: string;
  docId: string;
}) {
  const [doc, setDoc] = useState<DocumentWithContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDoc = useCallback(async () => {
    try {
      const d = await fetchDocument(projectId, docId);
      setDoc(d);
      setTitle(d.title);
      setContent(d.content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, docId]);

  useEffect(() => {
    loadDoc();
  }, [loadDoc]);

  // Poll every 10s when not editing
  useEffect(() => {
    if (editing) return;
    const id = setInterval(loadDoc, 10_000);
    return () => clearInterval(id);
  }, [loadDoc, editing]);

  const handleSave = async () => {
    if (!doc) return;
    try {
      await updateDocumentApi(projectId, doc.id, { title, content });
      const updated = await fetchDocument(projectId, doc.id);
      setDoc(updated);
      setTitle(updated.title);
      setContent(updated.content);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!doc) return;
    try {
      await deleteDocumentApi(projectId, doc.id);
      window.location.hash = `#/projects/${projectId}/documents`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const renderedHtml = useMemo(
    () => (doc ? (marked.parse(doc.content) as string) : ""),
    [doc],
  );

  const goBack = () => {
    window.location.hash = `#/projects/${projectId}/documents`;
  };

  if (loading) {
    return (
      <div className="doc-page">
        <div className="skeleton-card" style={{ height: 200 }} />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="doc-page">
        <div className="empty-state">
          Document not found.{" "}
          <button className="tasks-edit-btn" onClick={goBack}>
            Back to documents
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-page">
      {error && (
        <div className="tasks-error">
          {error}
          <button className="tasks-error-dismiss" onClick={() => setError(null)}>x</button>
        </div>
      )}

      {/* Top bar */}
      <div className="doc-page-header">
        <button className="doc-back-btn" onClick={goBack}>
          Back
        </button>
        <div className="doc-page-actions">
          {editing ? (
            <>
              <button className="tasks-submit-btn" onClick={handleSave}>Save</button>
              <button
                className="tasks-cancel-btn"
                onClick={() => {
                  setTitle(doc.title);
                  setContent(doc.content);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="tasks-edit-btn" onClick={() => setEditing(true)}>Edit</button>
              <button className="tasks-delete-btn" onClick={handleDelete}>Delete</button>
            </>
          )}
        </div>
      </div>

      {/* Title */}
      {editing ? (
        <input
          className="doc-page-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      ) : (
        <h2 className="doc-page-title">{doc.title}</h2>
      )}

      {/* Meta */}
      <div className="doc-page-meta">
        <span>{doc.filename}</span>
        <span>{doc.id}</span>
        <span>{relativeTime(doc.updated_at)}</span>
      </div>

      {/* Content */}
      {editing ? (
        <textarea
          className="doc-editor"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      ) : (
        <div className="doc-page-content markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      )}
    </div>
  );
}
