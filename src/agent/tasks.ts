import { randomUUID } from 'node:crypto';

export interface TaskInfo {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

const tasks = new Map<string, TaskInfo>();

export function startTask(description: string, fn: () => Promise<string>): TaskInfo {
  const id = `task_${randomUUID().slice(0, 8)}`;
  const info: TaskInfo = {
    id,
    description,
    status: 'running',
    startedAt: Date.now(),
  };
  tasks.set(id, info);

  fn().then(
    (result) => {
      info.status = 'completed';
      info.completedAt = Date.now();
      info.result = result;
    },
    (err) => {
      info.status = 'failed';
      info.completedAt = Date.now();
      info.error = (err as Error).message;
    },
  );

  return info;
}

export function getTask(id: string): TaskInfo | undefined {
  return tasks.get(id);
}

export function listTasks(): TaskInfo[] {
  return [...tasks.values()];
}
