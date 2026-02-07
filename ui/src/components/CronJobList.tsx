import { useState } from 'react';
import { triggerCronJob, toggleCronJob, type CronData } from '../api';

export function CronJobList(props: { data: CronData; onJobTriggered?: () => void }) {
  const { data, onJobTriggered } = props;
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  if (!data.enabled) {
    return <div className="cron-banner">Cron is disabled globally. Enable it in config to schedule jobs.</div>;
  }

  if (data.jobs.length === 0) {
    return <div className="empty-state">No cron jobs configured.</div>;
  }

  const handleRun = async (name: string) => {
    setRunning((prev) => ({ ...prev, [name]: true }));
    try {
      await triggerCronJob(name);
      onJobTriggered?.();
    } catch (err) {
      console.error(`Failed to trigger job "${name}":`, err);
    } finally {
      setRunning((prev) => ({ ...prev, [name]: false }));
    }
  };

  const handleToggle = async (name: string, currentlyEnabled: boolean) => {
    setToggling((prev) => ({ ...prev, [name]: true }));
    try {
      await toggleCronJob(name, !currentlyEnabled);
      onJobTriggered?.();
    } catch (err) {
      console.error(`Failed to toggle job "${name}":`, err);
    } finally {
      setToggling((prev) => ({ ...prev, [name]: false }));
    }
  };

  return (
    <div className="cron-list">
      {data.jobs.map((job) => {
        const enabled = !!job.enabled;
        return (
          <div key={job.id} className={`cron-item${enabled ? '' : ' cron-item-disabled'}`}>
            <div className="cron-item-header">
              <button
                className={`cron-toggle ${enabled ? 'on' : 'off'}`}
                disabled={toggling[job.name]}
                onClick={() => handleToggle(job.name, enabled)}
                aria-label={enabled ? 'Disable job' : 'Enable job'}
              >
                <span className="cron-toggle-knob" />
              </button>
              <span className="cron-name">{job.name}</span>
              <span className="cron-schedule">{job.schedule}</span>
              <button
                className={`cron-run-btn${running[job.name] ? ' running' : ''}`}
                disabled={running[job.name] || !enabled}
                onClick={() => handleRun(job.name)}
              >
                {running[job.name] ? 'Running...' : 'Run'}
              </button>
            </div>
            <div className="cron-meta">
              {job.last_run ? `Last run ${formatRelative(job.last_run)}` : 'Never run'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso + 'Z');
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}
