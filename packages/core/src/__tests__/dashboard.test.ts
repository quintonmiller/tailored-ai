import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import {
  type DashboardWidget,
  dashboardWidgetRegistry,
  registerDashboardWidgetProvider,
  resolveDashboardWidgets,
} from "../dashboard/index.js";

function cfg(dashboard?: AgentConfig["dashboard"]): AgentConfig {
  return { dashboard } as AgentConfig;
}

const w = (id: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({ id, type: "list", ...extra });

describe("resolveDashboardWidgets", () => {
  beforeEach(() => dashboardWidgetRegistry.clear());
  afterEach(() => dashboardWidgetRegistry.clear());

  it("returns config widgets when no providers are registered", () => {
    const out = resolveDashboardWidgets(cfg({ widgets: [w("a"), w("b")] }));
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("merges provider widgets with config widgets", () => {
    registerDashboardWidgetProvider("p", () => [w("p1", { order: 5 })]);
    const out = resolveDashboardWidgets(cfg({ widgets: [w("c1", { order: 9 })] }));
    expect(out.map((x) => x.id)).toEqual(["p1", "c1"]);
  });

  it("lets a config entry override a provider widget by id (shallow merge)", () => {
    registerDashboardWidgetProvider("p", () => [w("shared", { title: "Provider", span: 1, order: 1 })]);
    const out = resolveDashboardWidgets(cfg({ widgets: [{ id: "shared", type: "list", title: "Mine" }] }));
    const shared = out.find((x) => x.id === "shared");
    expect(shared?.title).toBe("Mine"); // config wins
    expect(shared?.order).toBe(1); // provider field preserved
  });

  it("drops disabled widgets", () => {
    const out = resolveDashboardWidgets(cfg({ widgets: [w("on"), w("off", { enabled: false })] }));
    expect(out.map((x) => x.id)).toEqual(["on"]);
  });

  it("lets config disable a provider widget by id", () => {
    registerDashboardWidgetProvider("p", () => [w("x")]);
    const out = resolveDashboardWidgets(cfg({ widgets: [{ id: "x", type: "list", enabled: false }] }));
    expect(out.find((y) => y.id === "x")).toBeUndefined();
  });

  it("sorts by order then title", () => {
    const out = resolveDashboardWidgets(
      cfg({ widgets: [w("z", { order: 2 }), w("a", { order: 1, title: "B" }), w("b", { order: 1, title: "A" })] }),
    );
    expect(out.map((x) => x.id)).toEqual(["b", "a", "z"]); // order 1 (A,B titles) then order 2
  });

  it("ignores malformed entries (missing id or type)", () => {
    const out = resolveDashboardWidgets(
      cfg({ widgets: [w("ok"), { id: "", type: "list" }, { id: "x" } as DashboardWidget] }),
    );
    expect(out.map((x) => x.id)).toEqual(["ok"]);
  });

  it("survives a throwing provider", () => {
    registerDashboardWidgetProvider("bad", () => {
      throw new Error("boom");
    });
    registerDashboardWidgetProvider("good", () => [w("g")]);
    const out = resolveDashboardWidgets(cfg());
    expect(out.map((x) => x.id)).toEqual(["g"]);
  });
});

describe("builtin dashboard widgets", () => {
  it("provides defaults and respects dashboard.defaults=false", async () => {
    const { builtinDashboardWidgets } = await import("../dashboard/builtin.js");
    expect(builtinDashboardWidgets(cfg()).length).toBeGreaterThan(0);
    expect(builtinDashboardWidgets(cfg({ defaults: false }))).toEqual([]);
  });
});
