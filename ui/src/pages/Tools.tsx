import { useState, useEffect } from 'react';
import { fetchTools, type ToolInfo } from '../api';
import { ToolCard } from '../components/ToolCard';

export function Tools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTools()
      .then(setTools)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="tools-page">
      <h2>Tools ({tools.length})</h2>
      {error && <div className="empty-state">Error: {error}</div>}
      {tools.length === 0 && !error && <div className="empty-state">No tools loaded.</div>}
      <div className="tools-grid">
        {tools.map((t) => (
          <ToolCard key={t.name} tool={t} />
        ))}
      </div>
    </div>
  );
}
