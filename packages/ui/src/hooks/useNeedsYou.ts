import { useCallback, useEffect, useState } from "react";
import {
  fetchAllPendingForms,
  fetchPendingApprovals,
  fetchProjectTasks,
  fetchWorkflowRuns,
  type PendingApprovalRequest,
  type ProjectTask,
  type WorkflowFormPendingRow,
  type WorkflowRunRow,
} from "../api";

/** Kind drives the deep-link target and the ghost action label. */
export type NeedsYouKind = "blocked" | "stalled" | "form" | "approval" | "failed";

export interface NeedsYouItem {
  /** Stable list key. */
  key: string;
  kind: NeedsYouKind;
  /** One-line title (ellipsised in the UI). */
  title: string;
  /** Full reason, shown in the row's `title` attribute. */
  reason: string;
  /** ISO timestamp the age is derived from. */
  when: string | null;
  /** Deep-link href for the ghost action. */
  href: string;
  /** Ghost action label. */
  action: string;
}

const POLL_MS = 30000;

/**
 * The single source for the Home "NEEDS YOU" stack. Merges exactly the four
 * sources the old Dashboard's "Needs Human" section used — blocked tasks,
 * pending workflow forms, pending tool approvals, and failed workflow runs —
 * into a flat, kind-tagged, time-sorted list. Each source is config-gated on
 * the server; a disabled or failing source simply contributes nothing, so the
 * stack degrades gracefully to fewer (or zero) items.
 */
export function useNeedsYou(): { items: NeedsYouItem[] } {
  const [blocked, setBlocked] = useState<ProjectTask[]>([]);
  const [forms, setForms] = useState<WorkflowFormPendingRow[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalRequest[]>([]);
  const [failedRuns, setFailedRuns] = useState<WorkflowRunRow[]>([]);

  const refresh = useCallback(() => {
    fetchProjectTasks({ status: "blocked", order_by: "updated_at", limit: 10 })
      .then((r) => setBlocked(r.tasks))
      .catch(() => {});
    fetchAllPendingForms()
      .then((r) => setForms(r.forms))
      .catch(() => {});
    fetchPendingApprovals()
      .then(setApprovals)
      .catch(() => {});
    fetchWorkflowRuns({ limit: 8 })
      .then((runs) => setFailedRuns(runs.filter((r) => r.status === "failed")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const items: NeedsYouItem[] = [];

  for (const f of forms) {
    items.push({
      key: `form-${f.id}`,
      kind: "form",
      title: f.prompt || `${f.step_name} input required`,
      reason: f.prompt || `${f.step_name} input required`,
      when: f.created_at,
      href: `#/workflow-runs/${encodeURIComponent(f.run_id)}`,
      action: "Fill",
    });
  }
  for (const a of approvals) {
    items.push({
      key: `approval-${a.requestId}`,
      kind: "approval",
      title: a.description || a.toolName,
      reason: a.description ? `${a.description} (${a.toolName})` : a.toolName,
      when: null,
      href: "#/approvals",
      action: "Review",
    });
  }
  for (const t of blocked) {
    // A blocked task with a recorded reason is a question for you; one without
    // is stalled and needs a decision. The label follows that distinction.
    const hasReason = Boolean(t.blocked_reason?.trim());
    items.push({
      key: `blocked-${t.id}`,
      kind: hasReason ? "blocked" : "stalled",
      title: t.title,
      reason: t.blocked_reason?.trim() || "Blocked, no reason recorded",
      when: t.updated_at,
      href: `#/tasks/${encodeURIComponent(t.id)}`,
      action: hasReason ? "Answer" : "Decide",
    });
  }
  for (const r of failedRuns) {
    items.push({
      key: `run-${r.id}`,
      kind: "failed",
      title: r.workflow_name,
      reason: r.error || "Workflow run failed",
      when: r.completed_at ?? r.started_at,
      href: `#/workflow-runs/${encodeURIComponent(r.id)}`,
      action: "Open",
    });
  }

  items.sort((a, b) => {
    if (!a.when && !b.when) return 0;
    if (!a.when) return -1; // approvals (no timestamp) float to the top
    if (!b.when) return 1;
    return a.when < b.when ? 1 : -1;
  });

  return { items };
}
