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

  /**
   * #609. A plugin can register a trigger kind, the loader accepts it, the UI
   * lists it — and `reconcile` filtered it out with nothing said, so the only
   * symptom was that the workflow never ran. Same shape as #561.
   *
   * These assert the *warning*, not the firing: nothing dispatches a plugin
   * kind until #61 lands. The point is that the gap is audible.
   */
  describe("a kind with no runner", () => {
    const orphan = (): WorkflowTriggerDef => ({ kind: "smart_doorbell" }) as WorkflowTriggerDef;

    it("warns, naming the workflow and the kind", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new WorkflowTriggerCoordinator(makePollers()).reconcile(fakeRegistry([wf("doorbell", [orphan()])]));
        const said = warn.mock.calls.flat().join(" ");
        expect(said).toContain("doorbell");
        expect(said).toContain("smart_doorbell");
        expect(said).toContain("never fire");
      } finally {
        warn.mockRestore();
      }
    });

    it("warns once, not once per reconcile", () => {
      // The load-bearing one. reconcile() runs on every registry change, and a
      // per-tick warning is noise people learn to scroll past — which is the
      // same outcome as silence.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const co = new WorkflowTriggerCoordinator(makePollers());
        const reg = fakeRegistry([wf("doorbell", [orphan()])]);
        co.reconcile(reg);
        co.reconcile(reg);
        co.reconcile(reg);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    it("stays quiet for kinds something else runs", () => {
      // cron, webhook and the rest fire from their own subsystems. Warning on
      // those would train everyone to ignore the message.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new WorkflowTriggerCoordinator(makePollers()).reconcile(
          fakeRegistry([
            wf("a", [{ kind: "cron", schedule: "* * * * *" } as WorkflowTriggerDef]),
            wf("b", [{ kind: "webhook" } as WorkflowTriggerDef]),
            wf("c", [{ kind: "manual" } as WorkflowTriggerDef]),
            wf("d", [{ kind: "tool_called", tool: "read" } as WorkflowTriggerDef]),
            wf("e", [{ kind: "document_event" } as WorkflowTriggerDef]),
            wf("f", [{ kind: "config_event" } as WorkflowTriggerDef]),
          ]),
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("stays quiet for every kind it actually dispatches", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        new WorkflowTriggerCoordinator(makePollers()).reconcile(
          fakeRegistry([wf("a", [rssTrig("u"), emailTrig("q")])]),
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("still registers the runnable triggers alongside an unrunnable one", () => {
      // A bad kind must not cost the workflow its working triggers.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const pollers = makePollers();
        new WorkflowTriggerCoordinator(pollers).reconcile(fakeRegistry([wf("mixed", [orphan(), rssTrig("u")])]));
        expect(pollers.rss.register).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    it("warns again when the workflow is fixed and then broken again", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const co = new WorkflowTriggerCoordinator(makePollers());
        co.reconcile(fakeRegistry([wf("doorbell", [orphan()])]));
        co.reconcile(fakeRegistry([wf("doorbell", [rssTrig("u")])]));
        co.reconcile(fakeRegistry([wf("doorbell", [orphan()])]));
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
