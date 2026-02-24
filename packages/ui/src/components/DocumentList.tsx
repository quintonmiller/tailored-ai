import { useCallback, useEffect, useState } from "react";
import {
  type DocumentMeta,
  createDocumentApi,
  fetchDocuments,
} from "../api";

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

export function DocumentList({
  projectId,
}: {
  projectId: string;
}) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    try {
      const res = await fetchDocuments(projectId, search || undefined);
      setDocs(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, search]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Poll every 10s
  useEffect(() => {
    const id = setInterval(loadDocs, 10_000);
    return () => clearInterval(id);
  }, [loadDocs]);

  const handleCreate = async () => {
    if (!formTitle.trim()) return;
    try {
      await createDocumentApi(projectId, {
        title: formTitle,
        content: formContent,
      });
      setShowForm(false);
      setFormTitle("");
      setFormContent("");
      await loadDocs();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="doc-list-header">
        <input
          className="tasks-search"
          placeholder="Search documents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="tasks-new-btn" onClick={() => setShowForm(true)}>
          + New Document
        </button>
      </div>

      {error && (
        <div className="tasks-error">
          {error}
          <button className="tasks-error-dismiss" onClick={() => setError(null)}>
            x
          </button>
        </div>
      )}

      {/* Create form modal */}
      {showForm && (
        <div className="tasks-form-overlay" onClick={() => setShowForm(false)}>
          <div className="tasks-form" onClick={(e) => e.stopPropagation()}>
            <h3>New Document</h3>
            <div className="field-group">
              <label className="field-label">Title</label>
              <input
                className="field-input"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) handleCreate();
                }}
                autoFocus
              />
            </div>
            <div className="field-group">
              <label className="field-label">Content (Markdown)</label>
              <textarea
                className="field-textarea"
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                rows={10}
                style={{ minHeight: 200 }}
              />
            </div>
            <div className="tasks-form-actions">
              <button className="tasks-cancel-btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button
                className="tasks-submit-btn"
                onClick={handleCreate}
                disabled={!formTitle.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document list */}
      {loading ? (
        <div className="skeleton-list">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      ) : docs.length === 0 ? (
        <div className="empty-state">
          No documents yet.{" "}
          <button className="tasks-new-btn" onClick={() => setShowForm(true)}>
            + Create one
          </button>
        </div>
      ) : (
        <div className="doc-list">
          {docs.map((d) => (
            <a
              key={d.id}
              className="doc-list-item"
              href={`#/projects/${projectId}/documents/${d.id}`}
            >
              <span className="doc-list-title">{d.title}</span>
              <span className="doc-list-filename">{d.filename}</span>
              <span className="doc-list-time">{relativeTime(d.updated_at)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
