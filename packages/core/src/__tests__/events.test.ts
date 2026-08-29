import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, type Subscription, TypedEventBus } from "../events.js";

let bus: EventBus;

beforeEach(() => {
  bus = new TypedEventBus();
});

describe("TypedEventBus.on + emit", () => {
  it("delivers a payload to a subscriber", () => {
    let received: { taskId: string; projectId?: string } | undefined;
    bus.on("task.created", (p) => {
      received = p;
    });
    bus.emit("task.created", { taskId: "t1", projectId: "proj" });
    expect(received).toEqual({ taskId: "t1", projectId: "proj" });
  });

  it("delivers the same event to every subscriber", () => {
    const seen: string[] = [];
    bus.on("task.created", (p) => seen.push(`a:${p.taskId}`));
    bus.on("task.created", (p) => seen.push(`b:${p.taskId}`));
    bus.on("task.created", (p) => seen.push(`c:${p.taskId}`));
    bus.emit("task.created", { taskId: "x" });
    expect(seen).toEqual(["a:x", "b:x", "c:x"]);
  });

  it("does nothing when nobody subscribed", () => {
    expect(() => bus.emit("task.created", { taskId: "x" })).not.toThrow();
  });

  it("does not deliver across event names", () => {
    let createdHits = 0;
    let updatedHits = 0;
    bus.on("task.created", () => createdHits++);
    bus.on("task.updated", () => updatedHits++);
    bus.emit("task.created", { taskId: "x" });
    expect(createdHits).toBe(1);
    expect(updatedHits).toBe(0);
  });
});

describe("TypedEventBus.off + Subscription.dispose", () => {
  it("dispose() stops further deliveries", () => {
    let hits = 0;
    const sub: Subscription = bus.on("task.created", () => hits++);
    bus.emit("task.created", { taskId: "1" });
    sub.dispose();
    bus.emit("task.created", { taskId: "2" });
    expect(hits).toBe(1);
  });

  it("dispose() is idempotent", () => {
    const handler = vi.fn();
    const sub = bus.on("task.created", handler);
    sub.dispose();
    expect(() => sub.dispose()).not.toThrow();
    bus.emit("task.created", { taskId: "x" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("off() by handler reference unsubscribes the matching handler only", () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.on("task.created", a);
    bus.on("task.created", b);
    bus.off("task.created", a);
    bus.emit("task.created", { taskId: "x" });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("off() on an unsubscribed handler is a no-op", () => {
    const handler = vi.fn();
    expect(() => bus.off("task.created", handler)).not.toThrow();
  });
});

describe("TypedEventBus error isolation", () => {
  it("a throwing sync handler does not stop later handlers", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    bus.on("task.created", () => {
      throw new Error("boom");
    });
    bus.on("task.created", after);
    bus.emit("task.created", { taskId: "x" });
    expect(after).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a rejected async handler is logged and does not propagate", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on("task.created", async () => {
      throw new Error("async boom");
    });
    bus.emit("task.created", { taskId: "x" });
    // Let the microtask queue flush so the catch handler runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a throwing handler does not poison the subscription set", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on("task.created", () => {
      throw new Error("boom");
    });
    bus.emit("task.created", { taskId: "1" });
    bus.emit("task.created", { taskId: "2" });
    bus.emit("task.created", { taskId: "3" });
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    errSpy.mockRestore();
  });
});

describe("TypedEventBus.clear", () => {
  it("removes every subscriber across all event names", () => {
    const createdHandler = vi.fn();
    const updatedHandler = vi.fn();
    bus.on("task.created", createdHandler);
    bus.on("task.updated", updatedHandler);
    bus.clear();
    bus.emit("task.created", { taskId: "x" });
    bus.emit("task.updated", { taskId: "x", changes: ["status"] });
    expect(createdHandler).not.toHaveBeenCalled();
    expect(updatedHandler).not.toHaveBeenCalled();
  });

  it("listenerCount returns 0 after clear", () => {
    bus.on("task.created", vi.fn());
    bus.on("task.created", vi.fn());
    bus.on("task.updated", vi.fn());
    bus.clear();
    expect(bus.listenerCount("task.created")).toBe(0);
    expect(bus.listenerCount("task.updated")).toBe(0);
  });
});

describe("TypedEventBus iteration safety", () => {
  it("a handler unsubscribing itself during dispatch does not skip the next handler", () => {
    const order: string[] = [];
    const subA = bus.on("task.created", () => {
      order.push("a");
      subA.dispose();
    });
    bus.on("task.created", () => order.push("b"));
    bus.emit("task.created", { taskId: "x" });
    expect(order).toEqual(["a", "b"]);
  });

  it("a handler adding a new subscriber during dispatch does not call the new one this round", () => {
    const order: string[] = [];
    bus.on("task.created", () => {
      order.push("a");
      bus.on("task.created", () => order.push("late"));
    });
    bus.emit("task.created", { taskId: "x" });
    expect(order).toEqual(["a"]);

    bus.emit("task.created", { taskId: "y" });
    expect(order).toEqual(["a", "a", "late"]);
  });
});

describe("TypedEventBus.listenerCount", () => {
  it("reports the right count per event", () => {
    expect(bus.listenerCount("task.created")).toBe(0);
    const a = bus.on("task.created", vi.fn());
    expect(bus.listenerCount("task.created")).toBe(1);
    bus.on("task.created", vi.fn());
    expect(bus.listenerCount("task.created")).toBe(2);
    a.dispose();
    expect(bus.listenerCount("task.created")).toBe(1);
  });
});
