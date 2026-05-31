import { useEffect, useState } from "react";

interface AnalyticsResponse {
  summary: {
    windowStart: string;
    windowEnd: string;
    totalRuns: number;
    byStatus: Record<string, number>;
    successRate: number;
    avgDurationMs: number | null;
  };
  perWorkflow: Array<{
    workflow_name: string;
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number;
    avgDurationMs: number | null;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
  }>;
  hotspots: Array<{
    step_name: string;
    step_type: string;
    attempts: number;
    failures: number;
    failureRate: number;
  }>;
  tokens: Array<{
    workflow_name: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function WorkflowAnalytics() {
  const [windowDays, setWindowDays] = useState(7);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    setError(null);
    fetch(`/api/workflow-analytics?since=${encodeURIComponent(since)}`)
      .then((r) => r.json())
      .then((d) => setData(d as AnalyticsResponse))
      .catch((e) => setError((e as Error).message));
  }, [windowDays]);

  return (
    <div className="wf-analytics-page">
      <header className="wf-page-header">
        <div className="wf-page-header-left">
          <h2>Workflow analytics</h2>
        </div>
        <div className="wf-page-header-right">
          <a href="#/workflows" className="btn-ghost">
            Workflows
          </a>
          <a href="#/workflow-runs" className="btn-ghost">
            Run history
          </a>
          <select
            className="field-select"
            value={String(windowDays)}
            onChange={(e) => setWindowDays(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                Last {w.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <div className="config-error">Error loading analytics: {error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}

      {data && (
        <div className="wf-analytics-body">
          <section className="wf-analytics-summary">
            <SummaryCard label="Total runs" value={String(data.summary.totalRuns)} />
            <SummaryCard label="Success rate" value={`${Math.round(data.summary.successRate * 100)}%`} />
            <SummaryCard label="Avg duration" value={formatMs(data.summary.avgDurationMs)} />
            <SummaryCard
              label="Statuses"
              value={
                Object.entries(data.summary.byStatus)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ") || "—"
              }
            />
          </section>

          <section>
            <h3>Per workflow</h3>
            <table className="wf-analytics-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Runs</th>
                  <th>Success</th>
                  <th>Avg</th>
                  <th>p50</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {data.perWorkflow.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-state">
                      No runs in window.
                    </td>
                  </tr>
                )}
                {data.perWorkflow.map((w) => (
                  <tr key={w.workflow_name}>
                    <td>
                      <a href={`#/workflows`}>{w.workflow_name}</a>
                    </td>
                    <td>{w.total}</td>
                    <td>{Math.round(w.successRate * 100)}%</td>
                    <td>{formatMs(w.avgDurationMs)}</td>
                    <td>{formatMs(w.p50DurationMs)}</td>
                    <td>{formatMs(w.p95DurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Top failing steps</h3>
            <table className="wf-analytics-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Type</th>
                  <th>Attempts</th>
                  <th>Failures</th>
                  <th>Failure %</th>
                </tr>
              </thead>
              <tbody>
                {data.hotspots.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-state">
                      No failing steps in window.
                    </td>
                  </tr>
                )}
                {data.hotspots.map((h) => (
                  <tr key={`${h.step_name}-${h.step_type}`}>
                    <td>{h.step_name}</td>
                    <td>{h.step_type}</td>
                    <td>{h.attempts}</td>
                    <td>{h.failures}</td>
                    <td>{Math.round(h.failureRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Token usage</h3>
            <table className="wf-analytics-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Prompt</th>
                  <th>Completion</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.tokens.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      No token usage attributed in window.
                    </td>
                  </tr>
                )}
                {data.tokens.map((t) => (
                  <tr key={t.workflow_name}>
                    <td>{t.workflow_name}</td>
                    <td>{t.prompt_tokens.toLocaleString()}</td>
                    <td>{t.completion_tokens.toLocaleString()}</td>
                    <td>{t.total_tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="wf-analytics-card">
      <div className="wf-analytics-card-label">{label}</div>
      <div className="wf-analytics-card-value">{value}</div>
    </div>
  );
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}
