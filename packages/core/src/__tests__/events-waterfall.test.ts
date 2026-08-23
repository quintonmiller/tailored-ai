import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../events.js";

// Exactly how a plugin declares its own waterfall event — core ships none yet,
// so this test file is also the worked example for the docs.
declare module "../events.js" {
  interface RuntimeWaterfallMap {
    "test.chain": { value: string; seen: string[] };
  }
}

const start = () => ({ value: "a", seen: [] as string[] });

describe("EventBus.waterfall", () => {
  it("returns the payload unchanged with no listeners", async () => {
    const bus = new TypedEventBus();
    const payload = start();
    await expect(bus.waterfall("test.chain", payload)).resolves.toBe(payload);
  });

  it("lets a listener transform the payload and delegate", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}+one` }));

    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a+one");
  });

  it("runs listeners in registration order, each seeing the previous result", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>1` }));
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>2` }));

    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a>1>2");
  });

  it("short-circuits when a listener returns without delegating", async () => {
    const bus = new TypedEventBus();
    const downstream = vi.fn((p: { value: string; seen: string[] }) => p);
    bus.onWaterfall("test.chain", (p) => ({ ...p, value: "owned" }));
    bus.onWaterfall("test.chain", (p, next) => next(downstream(p)));

    const out = await bus.waterfall("test.chain", start());
    // Short-circuiting is the design for a listener that owns the decision.
    expect(out.value).toBe("owned");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("runs a prepended listener first", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>ordinary` }));
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>first` }), { prepend: true });

    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a>first>ordinary");
  });

  it("skips a throwing listener and continues the chain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>1` }));
    bus.onWaterfall("test.chain", () => {
      throw new Error("bad listener");
    });
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>3` }));

    const out = await bus.waterfall("test.chain", start());
    // One bad subscriber must not break the operation it was only observing.
    expect(out.value).toBe("a>1>3");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps the downstream result when an observer delegates but returns nothing", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => {
      p.seen.push("observer");
      next(p);
      // Returns undefined after delegating — a pure observer written sloppily.
      return undefined as never;
    });
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>downstream` }));

    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a>downstream");
  });

  it("continues the chain when a listener returns nothing and never delegates", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", () => undefined as never);
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>survived` }));

    const out = await bus.waterfall("test.chain", start());
    // A forgotten `return` must not silently drop every listener after it.
    expect(out.value).toBe("a>survived");
  });

  it("stops calling a disposed listener", async () => {
    const bus = new TypedEventBus();
    const sub = bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: "changed" }));
    expect(bus.waterfallCount("test.chain")).toBe(1);

    sub.dispose();
    sub.dispose(); // idempotent

    expect(bus.waterfallCount("test.chain")).toBe(0);
    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a");
  });

  it("runs the chain it started with when a listener registers mid-dispatch", async () => {
    const bus = new TypedEventBus();
    const late = vi.fn();
    bus.onWaterfall("test.chain", (p, next) => {
      bus.onWaterfall("test.chain", (inner, innerNext) => {
        late();
        return innerNext(inner);
      });
      return next(p);
    });

    await bus.waterfall("test.chain", start());
    // Same rule as emit: a dispatch runs the snapshot it began with.
    expect(late).not.toHaveBeenCalled();
    await bus.waterfall("test.chain", start());
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("is cleared by clear(), along with broadcast handlers", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: "changed" }));
    bus.clear();

    expect(bus.waterfallCount("test.chain")).toBe(0);
    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a");
  });

  it("awaits async listeners in order", async () => {
    const bus = new TypedEventBus();
    bus.onWaterfall("test.chain", async (p, next) => {
      await new Promise((r) => setTimeout(r, 5));
      return next({ ...p, value: `${p.value}>slow` });
    });
    bus.onWaterfall("test.chain", (p, next) => next({ ...p, value: `${p.value}>fast` }));

    const out = await bus.waterfall("test.chain", start());
    expect(out.value).toBe("a>slow>fast");
  });
});
