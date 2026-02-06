import { useState, useEffect } from 'react';
import { fetchHealth, fetchSessions, type HealthInfo, type SessionRow } from '../api';
import { SessionList } from '../components/SessionList';
import { StatusBar } from '../components/StatusBar';

export function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((e) => setError(e.message));
    fetchSessions()
      .then(setSessions)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="dashboard">
      <h2>Status</h2>
      <div className="health-grid">
        <div className="health-card">
          <div className="label">Status</div>
          <div className={`value ${health?.status === 'ok' ? 'ok' : ''}`}>
            {health?.status ?? '...'}
          </div>
        </div>
        <div className="health-card">
          <div className="label">Provider</div>
          <div className="value">{health?.provider ?? '...'}</div>
        </div>
        <div className="health-card">
          <div className="label">Model</div>
          <div className="value">{health?.model ?? '...'}</div>
        </div>
        <div className="health-card">
          <div className="label">Tools</div>
          <div className="value">{health?.tools ?? '...'}</div>
        </div>
        <div className="health-card">
          <div className="label">Uptime</div>
          <div className="value">{health ? formatUptime(health.uptime) : '...'}</div>
        </div>
      </div>

      <h2>Sessions</h2>
      <SessionList sessions={sessions} />
      <StatusBar connected={!error} error={error} />
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
