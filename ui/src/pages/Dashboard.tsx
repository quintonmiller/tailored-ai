import { useState, useEffect, useRef } from 'react';
import {
  fetchHealth, fetchSessions, fetchProfiles, fetchCron, fetchTasks, fetchContext,
  type HealthInfo, type SessionRow, type ProfileInfo, type CronData, type TaskInfo, type ContextData,
} from '../api';
import { SessionList } from '../components/SessionList';
import { StatusBar } from '../components/StatusBar';
import { ProfileCard } from '../components/ProfileCard';
import { CronJobList } from '../components/CronJobList';
import { TaskList } from '../components/TaskList';
import { ContextFiles } from '../components/ContextFiles';

export function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileInfo>>({});
  const [cron, setCron] = useState<CronData | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [context, setContext] = useState<ContextData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const onError = (e: Error) => setError(e.message);

    fetchHealth().then(setHealth).catch(onError);
    fetchSessions().then(setSessions).catch(onError);
    fetchProfiles().then(setProfiles).catch(onError);
    fetchCron().then(setCron).catch(onError);
    fetchTasks().then(setTasks).catch(onError);
    fetchContext().then(setContext).catch(onError);
  }, []);

  // Auto-poll tasks when any are running
  useEffect(() => {
    const hasRunning = tasks.some((t) => t.status === 'running');
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchTasks().then(setTasks).catch(() => {});
      }, 5000);
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tasks]);

  const profileEntries = Object.entries(profiles);

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
          <div className="value">
            <a href="#/tools" className="health-link">{health?.tools ?? '...'}</a>
          </div>
        </div>
        <div className="health-card">
          <div className="label">Uptime</div>
          <div className="value">{health ? formatUptime(health.uptime) : '...'}</div>
        </div>
      </div>

      <h2>Profiles</h2>
      {profileEntries.length === 0 ? (
        <div className="empty-state">No profiles configured.</div>
      ) : (
        <div className="profile-grid">
          {profileEntries.map(([name, profile]) => (
            <ProfileCard key={name} name={name} profile={profile} />
          ))}
        </div>
      )}

      <h2>Cron Jobs</h2>
      {cron ? <CronJobList data={cron} /> : <div className="empty-state">Loading...</div>}

      <h2>Background Tasks</h2>
      <TaskList tasks={tasks} />

      <h2>Context Files</h2>
      {context ? <ContextFiles data={context} /> : <div className="empty-state">Loading...</div>}

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
