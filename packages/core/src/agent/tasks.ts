import { randomUUID } from "node:crypto";

export interface TaskInfo {
  id: string;
  description: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

const tasks = new Map<string, TaskInfo>();

/** Evict finished tasks older than 1 hour, keep at most 100 finished tasks. */
const FINISHED_TTL_MS = 60 * 60 * 1000;
const MAX_FINISHED = 100;

function evictFinished(): void {
  const now = Date.now();
  const finished: TaskInfo[] = [];
  for (const task of tasks.values()) {
    if (task.status !== "running") {
      if (task.completedAt && now - task.completedAt > FINISHED_TTL_MS) {
        tasks.delete(task.id);
      } else {
        finished.push(task);
      }
    }
  }
  // If still over cap, evict oldest finished first
  if (finished.length > MAX_FINISHED) {
    finished.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    const toEvict = finished.length - MAX_FINISHED;
    for (let i = 0; i < toEvict; i++) {
      tasks.delete(finished[i].id);
    }
  }
}

export function startTask(description: string, fn: () => Promise<string>): TaskInfo {
  evictFinished();

  const id = `task_${randomUUID().slice(0, 8)}`;
  const info: TaskInfo = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
  };
  tasks.set(id, info);

  fn().then(
    (result) => {
      info.status = "completed";
      info.completedAt = Date.now();
      info.result = result;
    },
    (err) => {
      info.status = "failed";
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
