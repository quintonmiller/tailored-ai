import { useEffect, useMemo, useState } from "react";
import { fetchTools, type ToolInfo } from "../api";
import { ToolCard } from "../components/ToolCard";

export function Tools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTools()
      .then(setTools)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return tools;
    const q = search.toLowerCase();
    return tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }, [tools, search]);

  return (
    <div className="tools-page">
      <div className="tools-header">
        <h2>Tools ({tools.length})</h2>
        {tools.length > 0 && (
          <input
            className="tools-search"
            type="text"
            placeholder="Filter tools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {loading && (
        <div className="skeleton-list">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      )}
      {error && <div className="empty-state">Error: {error}</div>}
      {!loading && tools.length === 0 && !error && <div className="empty-state">No tools loaded.</div>}
      {search && filtered.length === 0 && <div className="empty-state">No tools match "{search}"</div>}
      <div className="tools-grid">
        {filtered.map((t) => (
          <ToolCard key={t.name} tool={t} />
        ))}
      </div>
    </div>
  );
}
