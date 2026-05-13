import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import { GeofencePoller, haversineMeters } from "../triggers/geofence-poll.js";
import { WeatherPoller, compareNumeric } from "../triggers/weather-poll.js";
import { SensorPoller, resolveValuePath } from "../triggers/sensor-poll.js";
import { FinancePoller, parseStooqCsv } from "../triggers/finance-poll.js";
import { HomeAssistantPoller, matchesCondition } from "../triggers/home-assistant-poll.js";

function pokePoll(poller: unknown): Promise<void> {
  const p = poller as { poll: (r: unknown) => Promise<void>; regs: unknown[] };
  return p.poll(p.regs[0]);
}

function setupEngine() {
  const db = initDatabase(":memory:");
  const registry = new WorkflowRegistry();
  const engine = new WorkflowEngine({ db, registry });
  registry.register({
    name: "noop-wf",
    steps: [{ name: "noop", type: "tool_call", tool: "noop_tool" }],
  });
  return { db, engine };
}

describe("haversineMeters", () => {
  it("returns ~0 for the same point", () => {
    const d = haversineMeters({ lat: 40.0, lng: -74.0 }, { lat: 40.0, lng: -74.0 });
    expect(d).toBeLessThan(0.001);
  });

  it("computes great-circle distance accurately for ~1km offsets", () => {
    // 0.009 degrees latitude is roughly 1km.
    const d = haversineMeters({ lat: 40.0, lng: -74.0 }, { lat: 40.009, lng: -74.0 });
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });
});

describe("GeofencePoller", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    ({ db, engine } = setupEngine());
  });
  afterEach(() => db.close());

  it("primes silently on first poll, then fires on enter transition", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const fetchMock = vi.fn<typeof fetch>()
      // Prime: outside the fence
      .mockResolvedValueOnce(new Response(JSON.stringify({ lat: 40.1, lng: -74.0 }), { status: 200 }))
      // Inside the fence — should fire enter
      .mockResolvedValueOnce(new Response(JSON.stringify({ lat: 40.0, lng: -74.0 }), { status: 200 }));

    const poller = new GeofencePoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      locationUrl: "https://example.test/loc",
      center: { lat: 40.0, lng: -74.0 },
      radiusMeters: 200,
    });

    await pokePoll(poller);
    expect(spy).not.toHaveBeenCalled();

    await pokePoll(poller);
    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe("noop-wf");
    expect((input as { transition: string }).transition).toBe("enter");
    poller.stop();
  });

  it("does not fire on enter when direction=exit", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ lat: 40.1, lng: -74.0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ lat: 40.0, lng: -74.0 }), { status: 200 }));

    const poller = new GeofencePoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      locationUrl: "https://example.test/loc",
      center: { lat: 40.0, lng: -74.0 },
      radiusMeters: 200,
      direction: "exit",
    });

    await pokePoll(poller);
    await pokePoll(poller);
    expect(spy).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("compareNumeric", () => {
  it("handles all operators", () => {
    expect(compareNumeric(5, "gt", 3)).toBe(true);
    expect(compareNumeric(5, "lt", 3)).toBe(false);
    expect(compareNumeric(3, "gte", 3)).toBe(true);
    expect(compareNumeric(2, "lte", 3)).toBe(true);
    expect(compareNumeric(3, "eq", 3)).toBe(true);
  });
});

describe("WeatherPoller", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    ({ db, engine } = setupEngine());
  });
  afterEach(() => db.close());

  it("fires on rising-edge transition into the matched condition", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const cold = JSON.stringify({ current: { temperature_2m: 5, time: "2026-05-12T10:00" }, current_units: { temperature_2m: "°C" } });
    const hot = JSON.stringify({ current: { temperature_2m: 35, time: "2026-05-12T11:00" }, current_units: { temperature_2m: "°C" } });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(cold, { status: 200 }))
      .mockResolvedValueOnce(new Response(hot, { status: 200 }))
      .mockResolvedValueOnce(new Response(hot, { status: 200 }));

    const poller = new WeatherPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      lat: 40.0,
      lng: -74.0,
      field: "temperature_2m",
      op: "gt",
      threshold: 30,
      intervalSeconds: 600,
    });

    await pokePoll(poller); // prime cold (condition=false)
    await pokePoll(poller); // hot — condition flips false→true, fires
    await pokePoll(poller); // still hot — no double fire
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as { value: number }).value).toBe(35);
    poller.stop();
  });
});

describe("resolveValuePath", () => {
  it("walks dot keys", () => {
    expect(resolveValuePath({ a: { b: 7 } }, "a.b")).toBe(7);
  });
  it("walks array indices", () => {
    expect(resolveValuePath({ xs: [{ v: 9 }, { v: 11 }] }, "xs[1].v")).toBe(11);
  });
  it("walks quoted bracket keys", () => {
    expect(resolveValuePath({ s: { "with space": 42 } }, "s['with space']")).toBe(42);
  });
  it("returns undefined on missing path", () => {
    expect(resolveValuePath({ a: 1 }, "b.c")).toBeUndefined();
  });
});

describe("SensorPoller", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    ({ db, engine } = setupEngine());
  });
  afterEach(() => db.close());

  it("fires when the extracted value crosses the threshold (rising edge)", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { temp: 18 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { temp: 25 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { temp: 24 } }), { status: 200 }));

    const poller = new SensorPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      url: "https://example.test/sensor",
      valuePath: "data.temp",
      op: "gt",
      threshold: 20,
    });

    await pokePoll(poller); // prime: 18, condition=false
    await pokePoll(poller); // 25 — fires
    await pokePoll(poller); // 24 — still >20, no double fire
    expect(spy).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});

describe("parseStooqCsv", () => {
  it("parses the standard stooq response shape", () => {
    const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-05-09,22:00:01,182.50,184.10,181.90,183.75,12345678";
    const q = parseStooqCsv(csv);
    expect(q?.close).toBe(183.75);
    expect(q?.symbol).toBe("AAPL.US");
    expect(q?.volume).toBe(12345678);
  });

  it("returns undefined for malformed input", () => {
    expect(parseStooqCsv("")).toBeUndefined();
    expect(parseStooqCsv("only,one,line")).toBeUndefined();
  });

  it("treats N/D fields as NaN", () => {
    const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D";
    const q = parseStooqCsv(csv);
    expect(q).toBeDefined();
    expect(Number.isNaN(q!.close)).toBe(true);
  });
});

describe("FinancePoller", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    ({ db, engine } = setupEngine());
  });
  afterEach(() => db.close());

  it("fires on cross above threshold and stays quiet thereafter", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const make = (close: number) =>
      new Response(`Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-05-09,22:00:01,180,185,179,${close},10000`, { status: 200 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(make(178))
      .mockResolvedValueOnce(make(186))
      .mockResolvedValueOnce(make(190));

    const poller = new FinancePoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      symbol: "aapl.us",
      cross: "above",
      threshold: 185,
    });

    await pokePoll(poller); // 178: cond=false
    await pokePoll(poller); // 186: cond flips true, fires
    await pokePoll(poller); // 190: still above, no fire
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as { price: number }).price).toBe(186);
    poller.stop();
  });

  it("ignores off-hours N/D quotes without affecting state", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const nd = new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D", { status: 200 });
    const lowQuote = new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-05-09,22:00:01,180,185,179,180,10000", { status: 200 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(lowQuote)
      .mockResolvedValueOnce(nd);

    const poller = new FinancePoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", { symbol: "aapl.us", cross: "above", threshold: 185 });
    await pokePoll(poller);
    await pokePoll(poller);
    expect(spy).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("matchesHomeAssistantCondition", () => {
  it("matches on stateEquals", () => {
    expect(matchesCondition("on", { stateEquals: "on" })).toBe(true);
    expect(matchesCondition("off", { stateEquals: "on" })).toBe(false);
  });

  it("matches numeric thresholds", () => {
    expect(matchesCondition("23.5", { numericAbove: 22 })).toBe(true);
    expect(matchesCondition("18", { numericBelow: 20 })).toBe(true);
    expect(matchesCondition("unavailable", { numericAbove: 22 })).toBe(false);
  });
});

describe("HomeAssistantPoller", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    ({ db, engine } = setupEngine());
  });
  afterEach(() => db.close());

  it("fires once when state transitions into stateEquals match", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const mk = (state: string) =>
      new Response(JSON.stringify({ entity_id: "binary_sensor.front_door", state, attributes: { friendly_name: "Front Door" } }), { status: 200 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(mk("off"))
      .mockResolvedValueOnce(mk("on"))
      .mockResolvedValueOnce(mk("on"));

    const poller = new HomeAssistantPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      baseUrl: "http://hass.local:8123",
      token: "tok",
      entityId: "binary_sensor.front_door",
      stateEquals: "on",
    });

    await pokePoll(poller); // prime "off"
    await pokePoll(poller); // "on" — fires
    await pokePoll(poller); // still "on" — no double fire
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as { state: string }).state).toBe("on");
    poller.stop();
  });

  it("fires on every state change when onAnyChange=true", async () => {
    const spy = vi.spyOn(engine, "runWorkflow").mockResolvedValue({} as never);
    const mk = (state: string) =>
      new Response(JSON.stringify({ entity_id: "light.kitchen", state }), { status: 200 });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(mk("off"))
      .mockResolvedValueOnce(mk("on"))
      .mockResolvedValueOnce(mk("off"))
      .mockResolvedValueOnce(mk("off"));

    const poller = new HomeAssistantPoller({ workflowEngine: engine, fetchImpl: fetchMock });
    poller.register("noop-wf", {
      baseUrl: "http://hass.local:8123",
      token: "tok",
      entityId: "light.kitchen",
      onAnyChange: true,
    });

    await pokePoll(poller); // prime off
    await pokePoll(poller); // off→on, fires
    await pokePoll(poller); // on→off, fires
    await pokePoll(poller); // off→off, no fire
    expect(spy).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("rejects registration with no match mode", () => {
    const poller = new HomeAssistantPoller({ workflowEngine: engine });
    expect(() => poller.register("noop-wf", {
      baseUrl: "http://hass.local:8123",
      token: "tok",
      entityId: "x.y",
    })).toThrow(/one of/);
  });

  it("rejects registration with multiple match modes", () => {
    const poller = new HomeAssistantPoller({ workflowEngine: engine });
    expect(() => poller.register("noop-wf", {
      baseUrl: "http://hass.local:8123",
      token: "tok",
      entityId: "x.y",
      stateEquals: "on",
      onAnyChange: true,
    })).toThrow(/exactly one/);
  });
});
