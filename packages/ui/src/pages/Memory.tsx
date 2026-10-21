import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveFact,
  archiveMemoryNote,
  deleteFact,
  deleteMemoryNote,
  type FactRow,
  fetchFacts,
  fetchMemoryNotes,
  fetchMemoryRecall,
  fetchMemoryStats,
  type MemoryNote,
  type MemoryRecallHit,
  type MemoryStats,
  promoteMemoryNote,
  runMemorySweepHttp,
  unarchiveFact,
  unarchiveMemoryNote,
  updateMemoryNote,
} from "../api";
import { useActiveProject } from "../hooks/useActiveProject";

export function Memory() {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [search, setSearch] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallHits, setRecallHits] = useState<MemoryRecallHit[] | null>(null);
  const [filterTag, setFilterTag] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeProject = useActiveProject();

  const projectParam = activeProject ?? undefined;

  const reload = useCallback(() => {
    fetchMemoryNotes({
      project: projectParam,
      tag: filterTag || undefined,
      search: search || undefined,
      limit: 100,
      includeArchived: showArchived,
    })
      .then(setNotes)
      .catch(() => {});
    fetchMemoryStats(projectParam)
      .then(setStats)
      .catch(() => {});
    fetchFacts({
      project_id: projectParam ?? undefined,
      search: search || undefined,
      limit: 200,
      includeArchived: showArchived,
    })
      .then((r) => setFacts(r.facts))
      .catch(() => {});
  }, [projectParam, filterTag, search, showArchived]);

  async function handleDeleteFact(id: string) {
    if (!confirm(`Delete fact ${id} for good? Archive it instead to keep a copy you can restore.`)) return;
    await deleteFact(id);
    reload();
  }

  /** Archive or restore a note or fact; asks for an optional reason on the way out. */
  async function handleArchive(kind: "note" | "fact", id: string, restore: boolean) {
    let reason: string | undefined;
    if (!restore) {
      const answer = prompt(`Why archive this ${kind}? (optional)`);
      if (answer === null) return;
      reason = answer.trim() || undefined;
    }
    setBusy(true);
    try {
      if (kind === "note") await (restore ? unarchiveMemoryNote(id) : archiveMemoryNote(id, reason));
      else await (restore ? unarchiveFact(id) : archiveFact(id, reason));
      reload();
    } catch (e) {
      alert(`${restore ? "Restore" : "Archive"} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleRecall() {
    if (!recallQuery.trim()) {
      setRecallHits(null);
      return;
    }
    const res = await fetchMemoryRecall({
      q: recallQuery,
      project: projectParam,
      limit: 8,
    });
    setRecallHits(res.hits);
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete note ${id} for good? Archive it instead to keep a copy you can restore.`)) return;
    await deleteMemoryNote(id);
    reload();
  }

  async function handleTogglePin(n: MemoryNote) {
    const next = !isPinned(n);
    try {
      await updateMemoryNote(n.id, { pinned: next });
      reload();
    } catch (e) {
      alert(`Pin failed: ${(e as Error).message}`);
    }
  }

  async function handlePromote(id: string) {
    setBusy(true);
    try {
      const res = await promoteMemoryNote(id);
      if (res.alreadyPromoted) alert(`Already promoted (${res.chunkCount} chunks)`);
      else alert(`Promoted → ${res.chunkCount} chunks`);
      reload();
    } catch (e) {
      alert(`Promote failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSweep() {
    if (!confirm("Run memory sweep now? Expired low-importance notes will be archived.")) return;
    setBusy(true);
    try {
      const r = await runMemorySweepHttp();
      alert(
        `Swept: extended ${r.extendedTtl}, archived ${r.archivedExpired}. ` +
          `Remaining: ${r.remainingNotes} notes, ${r.totalChunks} chunks.`,
      );
      reload();
    } finally {
      setBusy(false);
    }
  }

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const n of notes) for (const t of n.tags) s.add(t);
    return Array.from(s).sort();
  }, [notes]);

  const { pinnedNotes, otherNotes, archivedNotes } = useMemo(() => {
    const p: MemoryNote[] = [];
    const o: MemoryNote[] = [];
    const a: MemoryNote[] = [];
    for (const n of notes) (n.archived_at ? a : isPinned(n) ? p : o).push(n);
    return { pinnedNotes: p, otherNotes: o, archivedNotes: a };
  }, [notes]);
  const liveNoteCount = notes.length - archivedNotes.length;
  const archivedCount = stats ? (stats.counts.archivedNotes ?? 0) + (stats.counts.archivedFacts ?? 0) : null;
  const noteRowProps = {
    showPromote: !!stats?.embeddingsEnabled,
    busy,
    onDelete: handleDelete,
    onPromote: handlePromote,
    onTogglePin: handleTogglePin,
    onArchive: (n: MemoryNote) => handleArchive("note", n.id, !!n.archived_at),
  };

  return (
    <div className="memory-page">
      <header className="memory-header">
        <h1>Memory</h1>
        <div className="memory-actions">
          <button type="button" className="btn-secondary" onClick={reload} disabled={busy}>
            Reload
          </button>
          <button
            type="button"
            className="btn-ghost memory-sweep-btn"
            onClick={handleSweep}
            disabled={busy}
            title="Archive expired low-importance notes"
          >
            Run sweep
          </button>
        </div>
      </header>

      {stats && (
        <section className="memory-stats">
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.counts.notes}</div>
            <div className="memory-stat-label">Notes</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.counts.facts ?? 0}</div>
            <div className="memory-stat-label">Facts</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.counts.sessionSummaries}</div>
            <div className="memory-stat-label">Session summaries</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.counts.chunks}</div>
            <div className="memory-stat-label">Chunks (long-term)</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.embeddingsEnabled ? "on" : "off"}</div>
            <div className="memory-stat-label">
              Embeddings{stats.embeddingModel ? ` (${stats.embeddingModel})` : ""}
            </div>
          </div>
        </section>
      )}

      <section className="memory-recall">
        <h2>Recall</h2>
        <div className="memory-recall-row">
          <input
            type="text"
            placeholder="Search memory for relevance…"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRecall()}
          />
          <button type="button" onClick={handleRecall}>
            Recall
          </button>
        </div>
        {recallHits && (
          <ul className="memory-recall-hits">
            {recallHits.length === 0 && <li className="memory-empty">(no matches)</li>}
            {recallHits.map((h) => (
              <li key={h.source}>
                <span className={`memory-tier-badge tier-${h.tier}`}>{h.tier}</span>
                <span className="memory-recall-score">{h.score.toFixed(2)}</span>
                <span className="memory-recall-source">{h.source}</span>
                <div className="memory-recall-snippet">{h.snippet}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {stats && stats.topReferenced.length > 0 && (
        <section className="memory-top-referenced">
          <h2>Most referenced</h2>
          <ul>
            {stats.topReferenced.map((n) => (
              <li key={n.id}>
                <span className="memory-ref-badge">{n.ref_count}×</span>
                <span className="memory-note-id">{n.id}</span>
                <div className="memory-note-content">{n.content}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="memory-notes">
        <h2>Notes ({liveNoteCount})</h2>
        <div className="memory-filters">
          <input
            type="text"
            placeholder="Substring search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reload()}
          />
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="memory-archived-toggle" title="Archived notes and facts are hidden from agents">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived{archivedCount ? ` (${archivedCount})` : ""}
          </label>
        </div>
        {notes.length === 0 && <div className="memory-empty">No notes match.</div>}
        {pinnedNotes.length > 0 && (
          <>
            <h3 className="memory-section-label">Pinned preferences</h3>
            <ul className="memory-note-list">
              {pinnedNotes.map((n) => (
                <NoteRow key={n.id} note={n} pinned {...noteRowProps} />
              ))}
            </ul>
          </>
        )}
        {otherNotes.length > 0 && (
          <>
            {pinnedNotes.length > 0 && <h3 className="memory-section-label">Notes</h3>}
            <ul className="memory-note-list">
              {otherNotes.map((n) => (
                <NoteRow key={n.id} note={n} pinned={false} {...noteRowProps} />
              ))}
            </ul>
          </>
        )}
        {archivedNotes.length > 0 && (
          <>
            <h3 className="memory-section-label">Archived — hidden from agents</h3>
            <ul className="memory-note-list">
              {archivedNotes.map((n) => (
                <NoteRow key={n.id} note={n} pinned={false} {...noteRowProps} />
              ))}
            </ul>
          </>
        )}
      </section>

      {facts.length > 0 && (
        <section className="memory-facts">
          <h2>Facts ({facts.length})</h2>
          <p className="memory-section-hint">
            Structured atoms the agent has saved via the <code>facts</code> tool — surfaced automatically by{" "}
            <code>recall</code> when relevant.
          </p>
          <ul className="memory-fact-list">
            {facts.map((f) => (
              <li key={f.id} className={`memory-fact${f.archived_at ? " memory-fact-archived" : ""}`}>
                <div className="memory-fact-key">
                  <span className="memory-fact-category">{f.category}</span>
                  {f.entity && <span className="memory-fact-entity">/ {f.entity}</span>}
                  <span className="memory-fact-attr">· {f.key}</span>
                </div>
                <div className="memory-fact-value">{f.value}</div>
                <div className="memory-fact-meta">
                  <span className="memory-fact-date">{f.updated_at.slice(0, 16).replace("T", " ")}</span>
                  {f.confidence != null && <span title="confidence">{(f.confidence * 100).toFixed(0)}%</span>}
                  {f.source && <span title="source">via {f.source}</span>}
                  <button
                    type="button"
                    className="memory-fact-archive"
                    onClick={() => handleArchive("fact", f.id, !!f.archived_at)}
                    disabled={busy}
                  >
                    {f.archived_at ? "Restore" : "Archive"}
                  </button>
                  <button
                    type="button"
                    className="memory-fact-delete"
                    onClick={() => handleDeleteFact(f.id)}
                    disabled={busy}
                    aria-label="Delete fact"
                  >
                    ×
                  </button>
                </div>
                {f.archived_at && (
                  <div className="memory-fact-stamp">
                    <ArchivedStamp at={f.archived_at} by={f.archived_by} reason={f.archive_reason} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function isPinned(n: MemoryNote): boolean {
  return n.tags.includes("pinned") || (n.importance ?? 0) >= 0.95;
}

/** "Archived 2d ago by sweep: expired" — when, who, and why, as far as they're known. */
function ArchivedStamp({ at, by, reason }: { at: string; by?: string | null; reason?: string | null }) {
  return (
    <span className="memory-archived-stamp" title={at}>
      Archived {relTime(sqliteToIso(at))}
      {by ? ` by ${by}` : ""}
      {reason ? `: ${reason}` : ""}
    </span>
  );
}

/** SQLite's `datetime('now')` has no zone; it is UTC, so say so before parsing. */
function sqliteToIso(t: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(" ", "T")}Z`;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const m = Math.floor((Date.now() - d.getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const day = Math.floor(h / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function NoteRow({
  note: n,
  pinned,
  showPromote,
  busy,
  onDelete,
  onPromote,
  onTogglePin,
  onArchive,
}: {
  note: MemoryNote;
  pinned: boolean;
  showPromote: boolean;
  busy: boolean;
  onDelete: (id: string) => void;
  onPromote: (id: string) => void;
  onTogglePin: (n: MemoryNote) => void;
  onArchive: (n: MemoryNote) => void;
}) {
  const archived = !!n.archived_at;
  return (
    <li className={`memory-note${pinned ? " memory-note-pinned" : ""}${archived ? " memory-note-archived" : ""}`}>
      <div className="memory-note-content">{n.content}</div>
      <div className="memory-note-meta">
        {n.archived_at ? (
          <ArchivedStamp at={n.archived_at} by={n.archived_by} reason={n.archive_reason} />
        ) : (
          <span className="memory-note-date">{relTime(n.created_at)}</span>
        )}
        {pinned && (
          <span className="memory-pin-badge" title="Always injected into system prompt">
            📌 pinned
          </span>
        )}
        {n.kept && (
          <span className="memory-kept-badge" title="Kept: the nightly sweep never archives it">
            kept
          </span>
        )}
        {n.tags.map((t) => (
          <span key={t} className="memory-tag-pill">
            {t}
          </span>
        ))}
      </div>
      <div className="memory-note-actions">
        {!archived && (
          <button type="button" className="btn-secondary" onClick={() => onTogglePin(n)} disabled={busy}>
            {pinned ? "Unpin" : "Pin"}
          </button>
        )}
        <button
          type="button"
          className={archived ? "btn-secondary" : "btn-ghost"}
          onClick={() => onArchive(n)}
          disabled={busy}
          title={archived ? "Bring it back where agents can recall it" : "Hide it from agents; you can restore it"}
        >
          {archived ? "Restore" : "Archive"}
        </button>
        <button type="button" className="btn-ghost" onClick={() => onDelete(n.id)} disabled={busy}>
          Delete
        </button>
      </div>
      <details className="memory-note-details">
        <summary>Details</summary>
        <dl className="memory-note-detail-grid">
          <dt>ID</dt>
          <dd>
            <code>{n.id}</code>
          </dd>
          {n.agent && (
            <>
              <dt>Author</dt>
              <dd>{n.agent}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{n.created_at.slice(0, 16).replace("T", " ")}</dd>
          {n.importance != null && (
            <>
              <dt>Importance</dt>
              <dd>{n.importance.toFixed(2)}</dd>
            </>
          )}
          <dt>References</dt>
          <dd>{n.ref_count}×</dd>
        </dl>
        {showPromote && !archived && (
          <button type="button" className="btn-secondary" onClick={() => onPromote(n.id)} disabled={busy}>
            Promote to long-term
          </button>
        )}
      </details>
    </li>
  );
}
