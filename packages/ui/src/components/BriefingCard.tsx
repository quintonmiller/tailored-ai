import { useCallback, useEffect, useMemo, useState } from "react";
import { type BriefingResponse, fetchBriefing, refreshBriefing } from "../api";
import { renderMarkdown } from "../lib/markdown.js";

/**
 * Home-page briefing card. Renders nothing until `GET /api/briefing` confirms
 * the feature is enabled — so non-users see the unchanged Home. When enabled,
 * shows the LLM-written summary (markdown), a relative "generated X ago", and
 * a refresh button (spinner while regenerating). A skeleton holds the layout
 * during the first load so there's no jump.
 */
export function BriefingCard() {
  const [state, setState] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchBriefing()
      .then((r) => {
        if (!cancelled) setState(r);
      })
      .catch(() => {
        // Network/disabled failures hide the card rather than show an error.
        if (!cancelled) setState({ enabled: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshBriefing()
      .then((r) => setState(r))
      .catch(() => {
        // Keep the prior content on a refresh failure.
      })
      .finally(() => setRefreshing(false));
  }, []);

  const html = useMemo(() => {
    if (state?.enabled) return renderMarkdown(state.content || "");
    return "";
  }, [state]);

  // First load: a lightweight skeleton that occupies the card slot. We don't
  // yet know if the feature is enabled, so keep it visually quiet.
  if (loading) {
    return (
      <section className="dash-section briefing-card">
        <div className="briefing-skeleton skeleton-pulse" />
      </section>
    );
  }

  // Disabled (or failed) → render nothing. Home stays unchanged for non-users.
  if (!state?.enabled) return null;

  return (
    <section className="dash-section briefing-card">
      <header className="briefing-header">
        <h3>Briefing</h3>
        <div className="briefing-meta">
          {state.stale && <span className="briefing-stale">stale</span>}
          <span className="briefing-time">generated {relTime(state.generatedAt)}</span>
          <button
            type="button"
            className="briefing-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            title="Regenerate briefing"
            aria-label="Regenerate briefing"
          >
            <span className={refreshing ? "briefing-spinner" : ""}>↻</span>
          </button>
        </div>
      </header>
      <div className="briefing-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

function relTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return `${day}d ago`;
}
