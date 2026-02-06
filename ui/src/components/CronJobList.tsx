import type { CronData } from '../api';

export function CronJobList(props: { data: CronData }) {
  const { data } = props;

  if (!data.enabled) {
    return <div className="cron-banner">Cron is disabled globally. Enable it in config to schedule jobs.</div>;
  }

  if (data.jobs.length === 0) {
    return <div className="empty-state">No cron jobs configured.</div>;
  }

  return (
    <div className="cron-list">
      {data.jobs.map((job) => (
        <div key={job.id} className="cron-item">
          <div className="cron-item-header">
            <span className={`cron-dot ${job.enabled ? 'enabled' : 'disabled'}`} />
            <span className="cron-name">{job.name}</span>
            <span className="cron-schedule">{job.schedule}</span>
          </div>
          <div className="cron-meta">
            {job.last_run ? `Last run ${formatRelative(job.last_run)}` : 'Never run'}
          </div>
        </div>
      ))}
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
