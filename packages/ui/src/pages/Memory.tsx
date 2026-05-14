import { useEffect, useMemo, useState } from "react";
import {
  deleteMemoryNote,
  fetchMemoryNotes,
  fetchMemoryRecall,
  fetchMemoryStats,
  promoteMemoryNote,
  runMemorySweepHttp,
  updateMemoryNote,
  type MemoryNote,
  type MemoryRecallHit,
  type MemoryStats,
} from "../api";
import { useActiveProject } from "../hooks/useActiveProject";

export function Memory() {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [search, setSearch] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallHits, setRecallHits] = useState<MemoryRecallHit[] | null>(null);
  const [filterTag, setFilterTag] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const activeProject = useActiveProject();

  const projectParam = activeProject ?? undefined;

  function reload() {
    fetchMemoryNotes({
      project: projectParam,
      tag: filterTag || undefined,
      search: search || undefined,
      limit: 100,
    })
      .then(setNotes)
      .catch(() => {});
    fetchMemoryStats(projectParam)
      .then(setStats)
      .catch(() => {});
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject, filterTag]);

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
    if (!confirm(`Delete note ${id}?`)) return;
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
    if (!confirm("Run memory sweep now? Expired low-importance notes will be deleted.")) return;
    setBusy(true);
    try {
      const r = await runMemorySweepHttp();
      alert(
        `Swept: extended ${r.extendedTtl}, deleted ${r.deletedExpired}. ` +
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

  const { pinnedNotes, otherNotes } = useMemo(() => {
    const p: MemoryNote[] = [];
    const o: MemoryNote[] = [];
    for (const n of notes) (isPinned(n) ? p : o).push(n);
    return { pinnedNotes: p, otherNotes: o };
  }, [notes]);

  return (
    <div className="memory-page">
      <header className="memory-header">
        <h1>Memory</h1>
        <div className="memory-actions">
          <button type="button" onClick={reload} disabled={busy}>
            Reload
          </button>
          <button type="button" onClick={handleSweep} disabled={busy}>
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
            <div className="memory-stat-value">{stats.counts.sessionSummaries}</div>
            <div className="memory-stat-label">Session summaries</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.counts.chunks}</div>
            <div className="memory-stat-label">Chunks (long-term)</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">
              {stats.embeddingsEnabled ? "on" : "off"}
            </div>
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
        <h2>Notes ({notes.length})</h2>
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
        </div>
        {notes.length === 0 && <div className="memory-empty">No notes match.</div>}
        {pinnedNotes.length > 0 && (
          <>
            <h3 className="memory-section-label">Pinned preferences</h3>
            <ul className="memory-note-list">
              {pinnedNotes.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  pinned
                  showPromote={!!stats?.embeddingsEnabled}
                  busy={busy}
                  onDelete={handleDelete}
                  onPromote={handlePromote}
                  onTogglePin={handleTogglePin}
                />
              ))}
            </ul>
          </>
        )}
        {otherNotes.length > 0 && (
          <>
            {pinnedNotes.length > 0 && <h3 className="memory-section-label">Notes</h3>}
            <ul className="memory-note-list">
              {otherNotes.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  pinned={false}
                  showPromote={!!stats?.embeddingsEnabled}
                  busy={busy}
                  onDelete={handleDelete}
                  onPromote={handlePromote}
                  onTogglePin={handleTogglePin}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function isPinned(n: MemoryNote): boolean {
  return n.tags.includes("pinned") || (n.importance ?? 0) >= 0.95;
}

function NoteRow({
  note: n,
  pinned,
  showPromote,
  busy,
  onDelete,
  onPromote,
  onTogglePin,
}: {
  note: MemoryNote;
  pinned: boolean;
  showPromote: boolean;
  busy: boolean;
  onDelete: (id: string) => void;
  onPromote: (id: string) => void;
  onTogglePin: (n: MemoryNote) => void;
}) {
  return (
    <li className={`memory-note${pinned ? " memory-note-pinned" : ""}`}>
      <div className="memory-note-meta">
        <span className="memory-note-id">{n.id}</span>
        {n.agent && <span className="memory-note-agent">by {n.agent}</span>}
        <span className="memory-note-date">{n.created_at.slice(0, 16).replace("T", " ")}</span>
        {n.importance != null && (
          <span className="memory-note-importance" title="importance">
            ★ {n.importance.toFixed(2)}
          </span>
        )}
        {n.ref_count > 0 && <span className="memory-ref-badge">{n.ref_count}×</span>}
        {pinned && <span className="memory-pin-badge" title="Always injected into system prompt">📌 pinned</span>}
      </div>
      <div className="memory-note-content">{n.content}</div>
      {n.tags.length > 0 && (
        <div className="memory-note-tags">
          {n.tags.map((t) => (
            <span key={t} className="memory-tag-pill">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="memory-note-actions">
        <button type="button" onClick={() => onTogglePin(n)} disabled={busy}>
          {pinned ? "Unpin" : "Pin"}
        </button>
        {showPromote && (
          <button type="button" onClick={() => onPromote(n.id)} disabled={busy}>
            Promote
          </button>
        )}
        <button type="button" onClick={() => onDelete(n.id)} disabled={busy}>
          Delete
        </button>
      </div>
    </li>
  );
}
