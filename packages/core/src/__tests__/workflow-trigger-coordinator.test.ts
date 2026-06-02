/**
 * Tests for WorkflowTriggerCoordinator — the reconciler that #65 introduced
 * so workflow hot-reload doesn't leave pollers stale, duplicated, or
 * missing. Closes the bug where edits to a workflow YAML in
 * `data/workflows/` would never get picked up by the long-running pollers
 * because they were wired once at CLI startup.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkflowRegistry } from "../workflows/registry.js";
import { WorkflowTriggerCoordinator } from "../workflows/trigger-coordinator.js";
import type { RegisteredWorkflow, WorkflowTriggerDef } from "../workflows/types.js";

function makePollers() {
  return {
    fileDrop: { register: vi.fn(), unregister: vi.fn() },
    email: { register: vi.fn(), unregister: vi.fn() },
    calendar: { register: vi.fn(), unregister: vi.fn() },
    rss: { register: vi.fn(), unregister: vi.fn() },
    geofence: { register: vi.fn(), unregister: vi.fn() },
    weather: { register: vi.fn(), unregister: vi.fn() },
    sensor: { register: vi.fn(), unregister: vi.fn() },
    finance: { register: vi.fn(), unregister: vi.fn() },
    homeAssistant: { register: vi.fn(), unregister: vi.fn() },
  };
}

function wf(name: string, triggers: WorkflowTriggerDef[]): RegisteredWorkflow {
  return {
    definition: { name, steps: [{ name: "s", type: "shell", command: "echo" }], triggers },
    source: "programmatic",
    generation: 1,
  };
}

function fakeRegistry(workflows: RegisteredWorkflow[]): WorkflowRegistry {
  const listeners: Array<() => void> = [];
  return {
    list: () => workflows,
    onChange: (cb: () => void) => listeners.push(cb),
  } as unknown as WorkflowRegistry;
}

const rssTrig = (url: string): WorkflowTriggerDef => ({ kind: "rss", url });
const emailTrig = (q: string): WorkflowTriggerDef => ({ kind: "email_message", query: q });

describe("WorkflowTriggerCoordinator", () => {
  it("dispatches each pollable trigger to the matching poller on first reconcile", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    co.reconcile(
      fakeRegistry([
        wf("daily-news", [rssTrig("https://example.com/feed")]),
        wf("inbox-watcher", [emailTrig("newer_than:1d")]),
      ]),
    );
    expect(pollers.rss.register).toHaveBeenCalledOnce();
    expect(pollers.rss.register).toHaveBeenCalledWith("daily-news", { kind: "rss", url: "https://example.com/feed" });
    expect(pollers.email.register).toHaveBeenCalledOnce();
    expect(pollers.email.register).toHaveBeenCalledWith("inbox-watcher", "newer_than:1d", undefined);
  });

  it("is a no-op when reconciled twice with the same workflows (no duplicate timers)", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    const reg = fakeRegistry([wf("x", [rssTrig("u")])]);
    co.reconcile(reg);
    co.reconcile(reg);
    expect(pollers.rss.register).toHaveBeenCalledOnce();
    expect(pollers.rss.unregister).not.toHaveBeenCalled();
  });

  it("unregisters all pollers for a workflow that disappears", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    co.reconcile(fakeRegistry([wf("daily-news", [rssTrig("u")])]));
    co.reconcile(fakeRegistry([])); // workflow gone
    expect(pollers.rss.unregister).toHaveBeenCalledWith("daily-news");
    expect(co.list()).toEqual([]);
  });

  it("unregisters and re-registers when a workflow's triggers change", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    co.reconcile(fakeRegistry([wf("x", [rssTrig("v1")])]));
    expect(pollers.rss.register).toHaveBeenCalledOnce();
    co.reconcile(fakeRegistry([wf("x", [rssTrig("v2")])]));
    expect(pollers.rss.unregister).toHaveBeenCalledWith("x");
    expect(pollers.rss.register).toHaveBeenCalledTimes(2);
    expect(pollers.rss.register).toHaveBeenLastCalledWith("x", { kind: "rss", url: "v2" });
  });

  it("adds new workflows without re-registering existing ones", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    co.reconcile(fakeRegistry([wf("a", [rssTrig("u")])]));
    co.reconcile(fakeRegistry([wf("a", [rssTrig("u")]), wf("b", [emailTrig("q")])]));
    expect(pollers.rss.register).toHaveBeenCalledOnce(); // a stayed put
    expect(pollers.email.register).toHaveBeenCalledOnce(); // b new
    expect(pollers.rss.unregister).not.toHaveBeenCalled();
  });

  it("ignores non-pollable trigger kinds (cron, manual, webhook, etc.)", () => {
    const pollers = makePollers();
    const co = new WorkflowTriggerCoordinator(pollers);
    co.reconcile(
      fakeRegistry([
        wf("cron-only", [{ kind: "cron", schedule: "0 * * * *" }]),
        wf("manual-only", [{ kind: "manual" }]),
        wf("webhook-only", [{ kind: "webhook" }]),
      ]),
    );
    expect(pollers.rss.register).not.toHaveBeenCalled();
    expect(pollers.email.register).not.toHaveBeenCalled();
    expect(co.list()).toEqual([]);
  });

  it("survives a poller throwing during register", () => {
    const pollers = makePollers();
    pollers.rss.register.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const co = new WorkflowTriggerCoordinator(pollers);
      co.reconcile(fakeRegistry([wf("rss-fail", [rssTrig("u")]), wf("ok", [emailTrig("q")])]));
      expect(warn).toHaveBeenCalled();
      // The other workflow still got registered — one failure doesn't block.
      expect(pollers.email.register).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("start() reconciles immediately and re-reconciles on registry changes", () => {
    const pollers = makePollers();
    let workflows = [wf("x", [rssTrig("u")])];
    const listeners: Array<() => void> = [];
    const reg = {
      list: () => workflows,
      onChange: (cb: () => void) => listeners.push(cb),
    } as unknown as WorkflowRegistry;

    const co = new WorkflowTriggerCoordinator(pollers);
    co.start(reg);
    expect(pollers.rss.register).toHaveBeenCalledOnce();

    // Simulate WorkflowRegistry change.
    workflows = [wf("x", [rssTrig("u")]), wf("y", [emailTrig("q")])];
    for (const cb of listeners) cb();
    expect(pollers.email.register).toHaveBeenCalledOnce();
  });
});
